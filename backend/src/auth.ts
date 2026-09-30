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
//
// Sessions are server-side: the cookie only carries a random session id, the database stores its SHA-256.
// This gives idle timeout, absolute lifetime and real revocation (logout, password change, disabled user).

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
    oidcLoginLabel: string;
    // empty = generated once and stored in the database
    sessionSecret: string;
    sessionMaxAgeHours: number;
    // 0 = no idle timeout
    sessionIdleMinutes: number;
    allowSelfSigned: boolean;
    localAdminUsername: string;
    localAdminPassword: string;
    // true = overwrite the local admin password from the environment at every start
    localAdminReset: boolean;
}

export type AuditFn = (event: string, data: Record<string, unknown>) => void;

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const IP_WINDOW_MS = 15 * 60000;
const IP_MAX_FAILURES = 30;
// last_seen_at is written at most once a minute per session
const TOUCH_INTERVAL_MS = 60000;

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
        oidcLoginLabel: env.OIDC_LOGIN_LABEL || 'Sign in with single sign-on',
        sessionSecret: env.SESSION_SECRET || '',
        sessionMaxAgeHours: env.SESSION_MAX_AGE_HOURS ? Number(env.SESSION_MAX_AGE_HOURS) : 8,
        sessionIdleMinutes: env.SESSION_IDLE_MINUTES !== undefined && env.SESSION_IDLE_MINUTES !== '' ? Number(env.SESSION_IDLE_MINUTES) : 30,
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
    if (!Number.isFinite(cfg.sessionIdleMinutes) || cfg.sessionIdleMinutes < 0) throw new Error('Invalid SESSION_IDLE_MINUTES');
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

// Contents of the signed cookie: only the session id and the pending OIDC login
interface CookieData {
    sid?: string;
    oidc?: { state: string; nonce: string; codeVerifier: string; returnTo: string };
}

function cookie(req: Request): CookieData {
    return (req.session ?? {}) as CookieData;
}

const hashSid = (sid: string) => crypto.createHash('sha256').update(sid).digest('hex');

// Current user (and session hash) resolved by the auth middleware for this request
const requestUsers = new WeakMap<Request, { user: AuthUser; sidHash: string }>();

export function getUser(req: Request): AuthUser | undefined {
    return requestUsers.get(req)?.user;
}

export class Auth {
    private clientPromise?: Promise<BaseClient>;
    private ipFailures = new Map<string, { count: number; since: number }>();

    constructor(private cfg: AuthConfig, private basePath: string, private store: Store, private audit: AuditFn = () => undefined) {
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
        return { local: this.cfg.local, oidc: this.cfg.oidc, oidcLabel: this.cfg.oidc ? this.cfg.oidcLoginLabel : undefined };
    }

    get sessionPolicy() {
        return { maxAgeHours: this.cfg.sessionMaxAgeHours, idleMinutes: this.cfg.sessionIdleMinutes };
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
            this.store.deleteUserSessions(existing.id);
            logger.warn({ user: existing.username }, 'Local admin password reset from LOCAL_ADMIN_PASSWORD');
            this.audit('user.password_reset', { user: existing.username, by: 'LOCAL_ADMIN_RESET_PASSWORD' });
        }
    }

    // Deletes expired and idle sessions (called periodically)
    purgeSessions(): void {
        const idleMs = this.cfg.sessionIdleMinutes > 0 ? this.cfg.sessionIdleMinutes * 60000 : 365 * 86400000;
        const n = this.store.purgeSessions(new Date(Date.now() - idleMs).toISOString());
        if (n > 0) logger.debug({ n }, 'Purged expired sessions');
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

    private startSession(req: Request, user: AuthUser): void {
        const sid = crypto.randomBytes(32).toString('base64url');
        const expires = new Date(Date.now() + this.cfg.sessionMaxAgeHours * 3600 * 1000).toISOString();
        this.store.createSession(hashSid(sid), JSON.stringify(user), user.localId ?? null, expires, req.ip ?? null, String(req.headers['user-agent'] ?? '').slice(0, 200) || null);
        cookie(req).sid = sid;
    }

    // Looks up the server-side session; local users are re-validated against the database on every request
    private resolveUser(req: Request): { user: AuthUser; sidHash: string } | undefined {
        const sid = cookie(req).sid;
        if (!sid) return undefined;
        const sidHash = hashSid(sid);
        const row = this.store.getSession(sidHash);
        if (!row) return undefined;
        const now = Date.now();
        const idleExpired = this.cfg.sessionIdleMinutes > 0 && now - new Date(row.last_seen_at).getTime() > this.cfg.sessionIdleMinutes * 60000;
        if (new Date(row.expires_at).getTime() < now || idleExpired) {
            this.store.deleteSession(sidHash);
            return undefined;
        }
        let user = JSON.parse(row.user_json) as AuthUser;
        if (user.source === 'oidc' && !this.cfg.oidc) return undefined;
        if (user.source === 'local') {
            if (!this.cfg.local || user.localId === undefined) return undefined;
            const local = this.store.getUserById(user.localId);
            if (!local || local.disabled) {
                this.store.deleteSession(sidHash);
                return undefined;
            }
            user = { ...user, name: local.username, roles: [local.role], admin: local.role === 'admin' };
        }
        if (now - new Date(row.last_seen_at).getTime() > TOUCH_INTERVAL_MS) this.store.touchSession(sidHash);
        return { user, sidHash };
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
        logger.info(`Authentication: ${[this.cfg.local && 'local users', this.cfg.oidc && `OIDC (${this.cfg.issuerUrl})`].filter(Boolean).join(' + ')}; session ${this.cfg.sessionMaxAgeHours}h max, ${this.cfg.sessionIdleMinutes || 'no'} min idle`);

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
            const resolved = this.resolveUser(req);
            if (resolved) requestUsers.set(req, resolved);
            else if (cookie(req).sid) delete cookie(req).sid;
            const open = [`${base}/api/me`, `${base}/api/login`];
            if (req.path.startsWith(`${base}/api/`) && !open.includes(req.path) && !resolved) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            next();
        });

        if (this.cfg.local) this.installLocal(app);
        if (this.cfg.oidc) this.installOidc(app);

        app.post(`${base}/auth/logout`, async (req, res) => {
            const current = requestUsers.get(req);
            const wasOidc = current?.user.source === 'oidc';
            if (current) {
                this.store.deleteSession(current.sidHash);
                this.audit('auth.logout', { user: current.user.name, ip: req.ip });
            }
            req.session = null;
            let logoutUrl = `${base}/`;
            if (wasOidc) {
                try {
                    const client = await this.client();
                    if (client.issuer.metadata.end_session_endpoint) {
                        logoutUrl = client.endSessionUrl({ post_logout_redirect_uri: `${this.cfg.publicUrl}/`, client_id: this.cfg.clientId });
                    }
                } catch {
                    // IdP not reachable: the local session is revoked anyway
                }
            }
            res.json({ logoutUrl });
        });

        // Signs out every other session of the current local user
        app.post(`${base}/api/account/logout-others`, (req, res) => {
            const current = requestUsers.get(req);
            if (current?.user.localId === undefined) return res.status(400).json({ error: 'Only local users can do this' });
            const revoked = this.store.deleteUserSessions(current.user.localId, current.sidHash);
            this.audit('auth.sessions_revoked', { user: current.user.name, revoked, by: current.user.name });
            res.json({ revoked });
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
                this.audit('auth.login_throttled', { user: username, ip });
                return res.status(429).json({ error: 'Too many failed logins, try again later' });
            }
            const user = this.store.getUserByUsername(username);
            if (user?.lockedUntil && new Date(user.lockedUntil) > new Date()) {
                this.audit('auth.login_locked', { user: user.username, ip });
                return res.status(429).json({ error: `Account locked after too many failed logins, try again in ${LOCK_MINUTES} minutes` });
            }
            const hash = user ? this.store.getPasswordHash(user.id)! : await getDummyHash();
            const ok = await verifyPassword(password, hash);
            if (!user || !ok || user.disabled) {
                this.ipFailed(ip);
                if (user && !ok) this.store.recordLoginFailure(user.id, MAX_FAILED_ATTEMPTS, LOCK_MINUTES);
                logger.warn({ user: username, ip }, 'Local login failed');
                this.audit('auth.login_failed', { user: username, ip, reason: !user ? 'unknown user' : user.disabled && ok ? 'disabled' : 'wrong password' });
                return res.status(401).json({ error: 'Invalid username or password' });
            }
            this.store.recordLoginSuccess(user.id);
            this.startSession(req, { source: 'local', sub: `local:${user.id}`, name: user.username, roles: [user.role], admin: user.role === 'admin', localId: user.id });
            logger.info({ user: user.username }, 'User logged in (local)');
            this.audit('auth.login', { user: user.username, source: 'local', ip });
            res.json({ success: true });
        }));

        app.post(`${base}/api/account/password`, asyncHandler(async (req, res) => {
            const current = requestUsers.get(req);
            const user = current?.user;
            if (user?.source !== 'local' || user.localId === undefined) return res.status(400).json({ error: 'Only local users can change their password here' });
            const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
            const hash = this.store.getPasswordHash(user.localId);
            if (typeof currentPassword !== 'string' || !hash || !(await verifyPassword(currentPassword, hash))) {
                return res.status(400).json({ error: 'Current password is wrong' });
            }
            const err = validatePassword(newPassword);
            if (err) return res.status(400).json({ error: err });
            this.store.updateUser(user.localId, { passwordHash: await hashPassword(newPassword as string) });
            // a new password signs out every other session of this user
            const revoked = this.store.deleteUserSessions(user.localId, current!.sidHash);
            logger.info({ user: user.name }, 'Password changed');
            this.audit('user.password_changed', { user: user.name, by: user.name, sessionsRevoked: revoked });
            res.json({ success: true, sessionsRevoked: revoked });
        }));

        // --- user management (admins) ---
        const admin = this.requireAdmin();

        app.get(`${base}/api/users`, admin, (_, res) => {
            res.json(this.store.listUsers().map((u) => ({ ...u, activeSessions: this.store.countUserSessions(u.id) })));
        });

        app.post(`${base}/api/users`, admin, asyncHandler(async (req, res) => {
            const { username, password, role } = (req.body ?? {}) as { username?: unknown; password?: unknown; role?: unknown };
            const err = validateUsername(username) ?? validatePassword(password) ?? (role === 'user' || role === 'admin' ? null : 'role must be user or admin');
            if (err) return res.status(400).json({ error: err });
            if (this.store.getUserByUsername(username as string)) return res.status(409).json({ error: 'Username already exists' });
            const created = this.store.createUser(username as string, await hashPassword(password as string), role as UserRole);
            logger.info({ user: created.username, role: created.role, by: getUser(req)?.name }, 'User created');
            this.audit('user.created', { user: created.username, role: created.role, by: getUser(req)?.name });
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
            // disabling or a password set by an admin signs the user out everywhere
            const revoked = disabled === true || password !== undefined ? this.store.deleteUserSessions(id) : 0;
            logger.info({ user: target.username, role, disabled, passwordReset: password !== undefined, by: me?.name }, 'User updated');
            this.audit('user.updated', { user: target.username, role, disabled, passwordReset: password !== undefined, sessionsRevoked: revoked, by: me?.name });
            res.json(this.store.getUserById(id));
        }));

        app.delete(`${base}/api/users/:id/sessions`, admin, (req, res) => {
            const id = Number(req.params.id);
            const target = this.store.getUserById(id);
            if (!target) return res.status(404).json({ error: 'User not found' });
            const current = requestUsers.get(req);
            const revoked = this.store.deleteUserSessions(id, current?.user.localId === id ? current.sidHash : undefined);
            this.audit('auth.sessions_revoked', { user: target.username, revoked, by: getUser(req)?.name });
            res.json({ revoked });
        });

        app.delete(`${base}/api/users/:id`, admin, (req, res) => {
            const id = Number(req.params.id);
            const target = this.store.getUserById(id);
            if (!target) return res.status(404).json({ error: 'User not found' });
            const me = getUser(req);
            if (me?.localId === id) return res.status(400).json({ error: 'You cannot delete yourself' });
            if (target.role === 'admin' && !target.disabled && this.store.countActiveAdmins() <= 1) {
                return res.status(400).json({ error: 'At least one active admin is required' });
            }
            this.store.deleteUserSessions(id);
            this.store.deleteUser(id);
            logger.info({ user: target.username, by: me?.name }, 'User deleted');
            this.audit('user.deleted', { user: target.username, by: me?.name });
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
                cookie(req).oidc = { state, nonce, codeVerifier, returnTo };
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
            const pending = cookie(req).oidc;
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
                delete cookie(req).oidc;
                if (this.cfg.userRole && !roles.includes(this.cfg.userRole) && !admin) {
                    logger.warn({ user: user.name }, 'Login denied: missing required role');
                    this.audit('auth.login_failed', { user: user.name, source: 'oidc', ip: req.ip, reason: 'missing role' });
                    req.session = null;
                    return res.status(403).send(`Access denied: role "${this.cfg.userRole}" required.`);
                }
                this.startSession(req, user);
                logger.info({ user: user.name }, 'User logged in (OIDC)');
                this.audit('auth.login', { user: user.name, source: 'oidc', ip: req.ip });
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
