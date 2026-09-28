import crypto from 'crypto';
import https from 'https';
import express, { Request, Response, NextFunction } from 'express';
import cookieSession from 'cookie-session';
import { BaseClient, Issuer, custom, generators } from 'openid-client';
import { logger, asyncHandler } from './expressUtils';
import { Store, UserRole } from './db';
import { getDummyHash, hashPassword, validatePassword, validateUsername, verifyPassword } from './password';

// Authentication modes (AUTH_MODE):
//   none        no login, every visitor is an admin (keep behind an authenticating proxy)
//   local       local users stored in the database
//   oidc        OpenID Connect (Keycloak, Authentik, ...)
//   local+oidc  both

export interface AuthUser {
    source: 'local' | 'oidc';
    sub: string;
    name: string;
    email?: string;
    roles: string[];
    admin: boolean;
    localId?: number;
}

export interface AuthConfig {
    local: boolean;
    oidc: boolean;
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    // public URL of the app including the base path, e.g. https://voucher.example.com/wifi
    publicUrl: string;
    scopes: string;
    // role required to use the app (empty = any authenticated user)
    userRole: string;
    // role required for history, settings and users (empty = any authenticated user)
    adminRole: string;
    // empty = generated once and stored in the database
    sessionSecret: string;
    sessionMaxAgeHours: number;
    allowSelfSigned: boolean;
    localAdminUsername: string;
    localAdminPassword: string;
    // true = overwrite the local admin password from the environment at every start
    localAdminReset: boolean;
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const IP_WINDOW_MS = 15 * 60000;
const IP_MAX_FAILURES = 30;

export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
    // Backward compatible default: OIDC if configured, otherwise no login
    const mode = (env.AUTH_MODE || (env.OIDC_ISSUER_URL ? 'oidc' : 'none')).toLowerCase();
    if (!['none', 'local', 'oidc', 'local+oidc'].includes(mode)) throw new Error(`Invalid AUTH_MODE: '${env.AUTH_MODE}'`);
    const cfg: AuthConfig = {
        local: mode === 'local' || mode === 'local+oidc',
        oidc: mode === 'oidc' || mode === 'local+oidc',
        issuerUrl: env.OIDC_ISSUER_URL || '',
        clientId: env.OIDC_CLIENT_ID || '',
        clientSecret: env.OIDC_CLIENT_SECRET || '',
        publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
        scopes: env.OIDC_SCOPES || 'openid profile email',
        userRole: env.OIDC_USER_ROLE || '',
        adminRole: env.OIDC_ADMIN_ROLE || '',
        sessionSecret: env.SESSION_SECRET || '',
        sessionMaxAgeHours: env.SESSION_MAX_AGE_HOURS ? Number(env.SESSION_MAX_AGE_HOURS) : 8,
        allowSelfSigned: env.OIDC_ALLOW_SELFSIGNED_HTTPS_CERTS === 'true',
        localAdminUsername: env.LOCAL_ADMIN_USERNAME || 'admin',
        localAdminPassword: env.LOCAL_ADMIN_PASSWORD || '',
        localAdminReset: env.LOCAL_ADMIN_RESET_PASSWORD === 'true',
    };
    if (cfg.oidc) {
        for (const [name, value] of Object.entries({ OIDC_ISSUER_URL: cfg.issuerUrl, OIDC_CLIENT_ID: cfg.clientId, PUBLIC_URL: cfg.publicUrl })) {
            if (!value) throw new Error(`${name} is required when AUTH_MODE includes oidc`);
        }
    }
    if (cfg.sessionSecret && cfg.sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
    if (!Number.isFinite(cfg.sessionMaxAgeHours) || cfg.sessionMaxAgeHours <= 0) throw new Error('Invalid SESSION_MAX_AGE_HOURS');
    return cfg;
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> {
    const parts = token?.split('.');
    if (!parts || parts.length !== 3) return {};
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return {};
    }
}

// Collects roles from Keycloak (realm_access / resource_access) and generic (groups / roles) claims
export function extractRoles(clientId: string, ...sources: Record<string, unknown>[]): string[] {
    const roles = new Set<string>();
    const add = (v: unknown) => {
        if (Array.isArray(v)) v.forEach((r) => typeof r === 'string' && roles.add(r.replace(/^\//, '')));
    };
    for (const src of sources) {
        add((src.realm_access as { roles?: unknown } | undefined)?.roles);
        add((src.resource_access as Record<string, { roles?: unknown }> | undefined)?.[clientId]?.roles);
        add(src.groups);
        add(src.roles);
    }
    return [...roles];
}

interface SessionData {
    user?: AuthUser;
    oidc?: { state: string; nonce: string; codeVerifier: string; returnTo: string };
}

function session(req: Request): SessionData {
    return (req.session ?? {}) as SessionData;
}

// Current user resolved by the auth middleware for this request
const requestUsers = new WeakMap<Request, AuthUser>();

export function getUser(req: Request): AuthUser | undefined {
    return requestUsers.get(req);
}

export class Auth {
    private clientPromise?: Promise<BaseClient>;
    private ipFailures = new Map<string, { count: number; since: number }>();

    constructor(private cfg: AuthConfig, private basePath: string, private store: Store) {
        if (cfg.oidc && cfg.allowSelfSigned) {
            custom.setHttpOptionsDefaults({ agent: new https.Agent({ rejectUnauthorized: false }) });
        }
        if (cfg.local && store.countUsers() === 0 && !cfg.localAdminPassword) {
            throw new Error('AUTH_MODE includes local but there are no users: set LOCAL_ADMIN_PASSWORD to create the first admin');
        }
        if (cfg.localAdminPassword) {
            const err = validatePassword(cfg.localAdminPassword);
            if (err) throw new Error(`LOCAL_ADMIN_PASSWORD: ${err}`);
            const uerr = validateUsername(cfg.localAdminUsername);
            if (uerr) throw new Error(`LOCAL_ADMIN_USERNAME: ${uerr}`);
        }
    }

    get enabled(): boolean {
        return this.cfg.local || this.cfg.oidc;
    }

    get modes() {
        return { local: this.cfg.local, oidc: this.cfg.oidc };
    }

    // Creates the first local admin (or resets its password when LOCAL_ADMIN_RESET_PASSWORD=true)
    async bootstrap(): Promise<void> {
        if (!this.cfg.local || !this.cfg.localAdminPassword) return;
        const existing = this.store.getUserByUsername(this.cfg.localAdminUsername);
        if (!existing) {
            this.store.createUser(this.cfg.localAdminUsername, await hashPassword(this.cfg.localAdminPassword), 'admin');
            logger.info({ user: this.cfg.localAdminUsername }, 'Created local admin user');
        } else if (this.cfg.localAdminReset) {
            this.store.updateUser(existing.id, { passwordHash: await hashPassword(this.cfg.localAdminPassword), role: 'admin', disabled: false });
            logger.warn({ user: existing.username }, 'Local admin password reset from LOCAL_ADMIN_PASSWORD');
        }
    }

    private get redirectUri(): string {
        return `${this.cfg.publicUrl}/auth/callback`;
    }

    // Issuer discovery is lazy and retried, so the app starts even if the IdP is down
    private client(): Promise<BaseClient> {
        if (!this.clientPromise) {
            this.clientPromise = Issuer.discover(this.cfg.issuerUrl)
                .then((issuer) => new issuer.Client({
                    client_id: this.cfg.clientId,
                    client_secret: this.cfg.clientSecret || undefined,
                    token_endpoint_auth_method: this.cfg.clientSecret ? 'client_secret_basic' : 'none',
                    redirect_uris: [this.redirectUri],
                    response_types: ['code'],
                }))
                .catch((err) => {
                    this.clientPromise = undefined;
                    throw err;
                });
        }
        return this.clientPromise;
    }

    isAdmin(user: AuthUser | undefined): boolean {
        if (!this.enabled) return true;
        return !!user?.admin;
    }

    private sessionSecret(): string {
        if (this.cfg.sessionSecret) return this.cfg.sessionSecret;
        let secret = this.store.getSetting<string>('sessionSecret', '');
        if (!secret) {
            secret = crypto.randomBytes(48).toString('base64');
            this.store.setSetting('sessionSecret', secret);
        }
        return secret;
    }

    // Local sessions are re-validated against the database on every request
    private resolveUser(req: Request): AuthUser | undefined {
        const u = session(req).user;
        if (!u) return undefined;
        if (u.source === 'oidc') return this.cfg.oidc ? u : undefined;
        if (!this.cfg.local || u.localId === undefined) return undefined;
        const local = this.store.getUserById(u.localId);
        if (!local || local.disabled) return undefined;
        return { ...u, name: local.username, roles: [local.role], admin: local.role === 'admin' };
    }

    private ipBlocked(ip: string): boolean {
        const e = this.ipFailures.get(ip);
        if (!e || Date.now() - e.since > IP_WINDOW_MS) return false;
        return e.count >= IP_MAX_FAILURES;
    }

    private ipFailed(ip: string): void {
        const e = this.ipFailures.get(ip);
        if (!e || Date.now() - e.since > IP_WINDOW_MS) this.ipFailures.set(ip, { count: 1, since: Date.now() });
        else e.count++;
    }

    install(app: express.Express): void {
        const base = this.basePath;
        if (!this.enabled) {
            logger.warn('Authentication disabled (AUTH_MODE=none): every visitor is an admin');
            return;
        }
        logger.info(`Authentication: ${[this.cfg.local && 'local users', this.cfg.oidc && `OIDC (${this.cfg.issuerUrl})`].filter(Boolean).join(' + ')}`);

        app.set('trust proxy', true);
        app.use(cookieSession({
            name: 'voucherbox_session',
            keys: [this.sessionSecret()],
            path: base || '/',
            httpOnly: true,
            sameSite: 'lax',
            secure: this.cfg.publicUrl.startsWith('https://'),
            maxAge: this.cfg.sessionMaxAgeHours * 3600 * 1000,
        }));

        // Resolve the user; API calls (except login/me) need a session. Pages and assets are public,
        // the frontend shows the login form when /api/me says the user is not authenticated.
        app.use((req: Request, res: Response, next: NextFunction) => {
            const user = this.resolveUser(req);
            if (user) requestUsers.set(req, user);
            else if (session(req).user) req.session = null;
            const open = [`${base}/api/me`, `${base}/api/login`];
            if (req.path.startsWith(`${base}/api/`) && !open.includes(req.path) && !user) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            next();
        });

        if (this.cfg.local) this.installLocal(app);
        if (this.cfg.oidc) this.installOidc(app);

        app.post(`${base}/auth/logout`, async (req, res) => {
            const wasOidc = session(req).user?.source === 'oidc';
            req.session = null;
            let logoutUrl = `${base}/`;
            if (wasOidc) {
                try {
                    const client = await this.client();
                    if (client.issuer.metadata.end_session_endpoint) {
                        logoutUrl = client.endSessionUrl({ post_logout_redirect_uri: `${this.cfg.publicUrl}/`, client_id: this.cfg.clientId });
                    }
                } catch {
                    // IdP not reachable: the local session is cleared anyway
                }
            }
            res.json({ logoutUrl });
        });
    }

    private installLocal(app: express.Express): void {
        const base = this.basePath;

        app.post(`${base}/api/login`, asyncHandler(async (req, res) => {
            const ip = req.ip ?? 'unknown';
            const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
            if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
                return res.status(400).json({ error: 'Username and password are required' });
            }
            if (this.ipBlocked(ip)) {
                return res.status(429).json({ error: 'Too many failed logins, try again later' });
            }
            const user = this.store.getUserByUsername(username);
            if (user?.lockedUntil && new Date(user.lockedUntil) > new Date()) {
                return res.status(429).json({ error: `Account locked after too many failed logins, try again in ${LOCK_MINUTES} minutes` });
            }
            const hash = user ? this.store.getPasswordHash(user.id)! : await getDummyHash();
            const ok = await verifyPassword(password, hash);
            if (!user || !ok || user.disabled) {
                this.ipFailed(ip);
                if (user && !ok) this.store.recordLoginFailure(user.id, MAX_FAILED_ATTEMPTS, LOCK_MINUTES);
                logger.warn({ user: username, ip }, 'Local login failed');
                return res.status(401).json({ error: 'Invalid username or password' });
            }
            this.store.recordLoginSuccess(user.id);
            session(req).user = { source: 'local', sub: `local:${user.id}`, name: user.username, roles: [user.role], admin: user.role === 'admin', localId: user.id };
            logger.info({ user: user.username }, 'User logged in (local)');
            res.json({ success: true });
        }));

        app.post(`${base}/api/account/password`, asyncHandler(async (req, res) => {
            const user = getUser(req);
            if (user?.source !== 'local' || user.localId === undefined) return res.status(400).json({ error: 'Only local users can change their password here' });
            const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
            const hash = this.store.getPasswordHash(user.localId);
            if (typeof currentPassword !== 'string' || !hash || !(await verifyPassword(currentPassword, hash))) {
                return res.status(400).json({ error: 'Current password is wrong' });
            }
            const err = validatePassword(newPassword);
            if (err) return res.status(400).json({ error: err });
            this.store.updateUser(user.localId, { passwordHash: await hashPassword(newPassword as string) });
            logger.info({ user: user.name }, 'Password changed');
            res.json({ success: true });
        }));

        // --- user management (admins) ---
        const admin = this.requireAdmin();

        app.get(`${base}/api/users`, admin, (_, res) => {
            res.json(this.store.listUsers());
        });

        app.post(`${base}/api/users`, admin, asyncHandler(async (req, res) => {
            const { username, password, role } = (req.body ?? {}) as { username?: unknown; password?: unknown; role?: unknown };
            const err = validateUsername(username) ?? validatePassword(password) ?? (role === 'user' || role === 'admin' ? null : 'role must be user or admin');
            if (err) return res.status(400).json({ error: err });
            if (this.store.getUserByUsername(username as string)) return res.status(409).json({ error: 'Username already exists' });
            const created = this.store.createUser(username as string, await hashPassword(password as string), role as UserRole);
            logger.info({ user: created.username, role: created.role, by: getUser(req)?.name }, 'User created');
            res.status(201).json(created);
        }));

        app.patch(`${base}/api/users/:id`, admin, asyncHandler(async (req, res) => {
            const id = Number(req.params.id);
            const target = this.store.getUserById(id);
            if (!target) return res.status(404).json({ error: 'User not found' });
            const me = getUser(req);
            const { role, disabled, password } = (req.body ?? {}) as { role?: unknown; disabled?: unknown; password?: unknown };
            if (role !== undefined && role !== 'user' && role !== 'admin') return res.status(400).json({ error: 'role must be user or admin' });
            if (disabled !== undefined && typeof disabled !== 'boolean') return res.status(400).json({ error: 'disabled must be a boolean' });
            if (password !== undefined) {
                const err = validatePassword(password);
                if (err) return res.status(400).json({ error: err });
            }
            const removesAdmin = target.role === 'admin' && !target.disabled && (role === 'user' || disabled === true);
            if (removesAdmin && me?.localId === id) return res.status(400).json({ error: 'You cannot demote or disable yourself' });
            if (removesAdmin && this.store.countActiveAdmins() <= 1) return res.status(400).json({ error: 'At least one active admin is required' });
            this.store.updateUser(id, {
                role: role as UserRole | undefined,
                disabled: disabled as boolean | undefined,
                passwordHash: password !== undefined ? await hashPassword(password as string) : undefined,
            });
            logger.info({ user: target.username, role, disabled, passwordReset: password !== undefined, by: me?.name }, 'User updated');
            res.json(this.store.getUserById(id));
        }));

        app.delete(`${base}/api/users/:id`, admin, (req, res) => {
            const id = Number(req.params.id);
            const target = this.store.getUserById(id);
            if (!target) return res.status(404).json({ error: 'User not found' });
            const me = getUser(req);
            if (me?.localId === id) return res.status(400).json({ error: 'You cannot delete yourself' });
            if (target.role === 'admin' && !target.disabled && this.store.countActiveAdmins() <= 1) {
                return res.status(400).json({ error: 'At least one active admin is required' });
            }
            this.store.deleteUser(id);
            logger.info({ user: target.username, by: me?.name }, 'User deleted');
            res.status(204).end();
        });
    }

    private installOidc(app: express.Express): void {
        const base = this.basePath;

        app.get(`${base}/auth/login`, async (req, res) => {
            try {
                const client = await this.client();
                const state = generators.state();
                const nonce = generators.nonce();
                const codeVerifier = generators.codeVerifier();
                const returnTo = typeof req.query.returnTo === 'string' && req.query.returnTo.startsWith(`${base}/`) ? req.query.returnTo : `${base}/`;
                session(req).oidc = { state, nonce, codeVerifier, returnTo };
                res.redirect(client.authorizationUrl({
                    scope: this.cfg.scopes,
                    redirect_uri: this.redirectUri,
                    state,
                    nonce,
                    code_challenge: generators.codeChallenge(codeVerifier),
                    code_challenge_method: 'S256',
                }));
            } catch (err) {
                logger.error({ err }, 'OIDC login failed');
                res.status(502).send('Identity provider not reachable. Try again later.');
            }
        });

        app.get(`${base}/auth/callback`, async (req, res) => {
            const pending = session(req).oidc;
            if (!pending) return res.redirect(`${base}/auth/login`);
            try {
                const client = await this.client();
                const tokenSet = await client.callback(this.redirectUri, client.callbackParams(req), {
                    state: pending.state,
                    nonce: pending.nonce,
                    code_verifier: pending.codeVerifier,
                });
                const claims = tokenSet.claims();
                const roles = extractRoles(this.cfg.clientId, claims, decodeJwtPayload(tokenSet.access_token));
                const admin = !this.cfg.adminRole || roles.includes(this.cfg.adminRole);
                const user: AuthUser = {
                    source: 'oidc',
                    sub: claims.sub,
                    name: String(claims.preferred_username || claims.name || claims.email || claims.sub),
                    email: typeof claims.email === 'string' ? claims.email : undefined,
                    roles,
                    admin,
                };
                delete session(req).oidc;
                if (this.cfg.userRole && !roles.includes(this.cfg.userRole) && !admin) {
                    logger.warn({ user: user.name }, 'Login denied: missing required role');
                    req.session = null;
                    return res.status(403).send(`Access denied: role "${this.cfg.userRole}" required.`);
                }
                session(req).user = user;
                logger.info({ user: user.name }, 'User logged in (OIDC)');
                res.redirect(pending.returnTo);
            } catch (err) {
                logger.error({ err }, 'OIDC callback failed');
                req.session = null;
                res.status(401).send(`Login failed. <a href="${base}/">Back</a>`);
            }
        });
    }

    requireAdmin() {
        return (req: Request, res: Response, next: NextFunction) => {
            if (this.isAdmin(getUser(req))) return next();
            res.status(403).json({ error: 'Admin role required' });
        };
    }
}
