import https from 'https';
import express, { Request, Response, NextFunction } from 'express';
import cookieSession from 'cookie-session';
import { BaseClient, Issuer, custom, generators } from 'openid-client';
import { logger } from './expressUtils';

// Optional OpenID Connect login (Keycloak, Authentik, ...). Disabled unless OIDC_ISSUER_URL is set.

export interface AuthUser {
    sub: string;
    name: string;
    email?: string;
    roles: string[];
}

export interface AuthConfig {
    enabled: boolean;
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    // public URL of the app including the base path, e.g. https://voucher.example.com/wifi
    publicUrl: string;
    scopes: string;
    // role required to use the app (empty = any authenticated user)
    userRole: string;
    // role required for history and settings (empty = any authenticated user)
    adminRole: string;
    sessionSecret: string;
    sessionMaxAgeHours: number;
    allowSelfSigned: boolean;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
    const enabled = !!env.OIDC_ISSUER_URL;
    const cfg: AuthConfig = {
        enabled,
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
    };
    if (enabled) {
        for (const [name, value] of Object.entries({ OIDC_CLIENT_ID: cfg.clientId, PUBLIC_URL: cfg.publicUrl, SESSION_SECRET: cfg.sessionSecret })) {
            if (!value) throw new Error(`${name} is required when OIDC_ISSUER_URL is set`);
        }
        if (cfg.sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
    }
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

export function getUser(req: Request): AuthUser | undefined {
    return session(req).user;
}

export class Auth {
    private clientPromise?: Promise<BaseClient>;

    constructor(private cfg: AuthConfig, private basePath: string) {
        if (cfg.enabled && cfg.allowSelfSigned) {
            custom.setHttpOptionsDefaults({ agent: new https.Agent({ rejectUnauthorized: false }) });
        }
    }

    get enabled(): boolean {
        return this.cfg.enabled;
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
        if (!this.cfg.enabled) return true;
        if (!user) return false;
        return !this.cfg.adminRole || user.roles.includes(this.cfg.adminRole);
    }

    install(app: express.Express): void {
        if (!this.cfg.enabled) {
            logger.info('OIDC login disabled (OIDC_ISSUER_URL not set)');
            return;
        }
        logger.info(`OIDC login enabled (issuer ${this.cfg.issuerUrl})`);
        const base = this.basePath;

        app.set('trust proxy', true);
        app.use(cookieSession({
            name: 'voucherbox_session',
            keys: [this.cfg.sessionSecret],
            path: base || '/',
            httpOnly: true,
            sameSite: 'lax',
            secure: this.cfg.publicUrl.startsWith('https://'),
            maxAge: this.cfg.sessionMaxAgeHours * 3600 * 1000,
        }));

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
                const user: AuthUser = {
                    sub: claims.sub,
                    name: String(claims.preferred_username || claims.name || claims.email || claims.sub),
                    email: typeof claims.email === 'string' ? claims.email : undefined,
                    roles,
                };
                delete session(req).oidc;
                if (this.cfg.userRole && !roles.includes(this.cfg.userRole) && !this.isAdmin(user)) {
                    logger.warn({ user: user.name }, 'Login denied: missing required role');
                    req.session = null;
                    return res.status(403).send(`Access denied: role "${this.cfg.userRole}" required.`);
                }
                session(req).user = user;
                logger.info({ user: user.name }, 'User logged in');
                res.redirect(pending.returnTo);
            } catch (err) {
                logger.error({ err }, 'OIDC callback failed');
                req.session = null;
                res.status(401).send(`Login failed. <a href="${base}/auth/login">Try again</a>`);
            }
        });

        app.post(`${base}/auth/logout`, async (req, res) => {
            req.session = null;
            let logoutUrl: string | undefined;
            try {
                const client = await this.client();
                if (client.issuer.metadata.end_session_endpoint) {
                    logoutUrl = client.endSessionUrl({ post_logout_redirect_uri: `${this.cfg.publicUrl}/`, client_id: this.cfg.clientId });
                }
            } catch {
                // IdP not reachable: the local session is cleared anyway
            }
            res.json({ logoutUrl: logoutUrl ?? `${base}/` });
        });

        // Everything else requires a logged-in user
        app.use((req: Request, res: Response, next: NextFunction) => {
            if (!req.path.startsWith(`${base}/`) && req.path !== base) return next();
            if (session(req).user) return next();
            if (req.path.startsWith(`${base}/api/`)) return res.status(401).json({ error: 'Not authenticated' });
            res.redirect(`${base}/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
        });
    }

    requireAdmin() {
        return (req: Request, res: Response, next: NextFunction) => {
            if (this.isAdmin(getUser(req))) return next();
            res.status(403).json({ error: 'Admin role required' });
        };
    }
}
