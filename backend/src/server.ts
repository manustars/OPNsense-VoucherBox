import express from 'express';
import handlebars from 'handlebars';
import mjml2html from 'mjml';
import fs from 'fs';
import dotenv from 'dotenv';
import pino from 'pino';
import { OpnsenseApi } from './OpnsenseApi';
import { Voucher } from './Models';
import { asyncHandler } from './expressUtils';
import { HistoryEntry, HistoryQuery, Store } from './db';
import { SyslogSettings, defaultSyslogSettings, sendSyslog, validateSyslogSettings } from './syslog';
import { Auth, getUser, loadAuthConfig } from './auth';
import { EmailConfig, EmailSettings, parseEmailSettings, sendMail, validateEmailSettings } from './email';
import { SecretBox } from './secrets';
import helmet from 'helmet';
import { Limits, checkLimits, defaultLimits, parseLimits, validateLimits } from './limits';
import { EmailContent, PLACEHOLDERS, RenderedEmail, VoucherValues, defaultEmailContent, formatDate, parseEmailContent, renderVoucherEmail, termsVersion, validateEmailContent } from './emailContent';
import path from 'path';
import QRCode from 'qrcode';

dotenv.config({ quiet: true });

const emailRegex = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    redact: process.env.NODE_ENV === "production" ? {
        paths: ['*'], // redact everywhere
        censor: (value) => {
            if (typeof value === 'string') {
                return value.replace(emailRegex, '***@redacted.at');
            }
            return value;
        }
    } : undefined,
    transport: process.env.NODE_ENV !== "production"
        ? {
            target: "pino-pretty",
            options: {
                colorize: true,
                translateTime: "SYS:standard",
                ignore: "pid,hostname",
            },
        }
        : undefined,
});



const app = express();
app.disable('x-powered-by');

// Reverse proxies in front of the app (ingress): req.ip is taken from X-Forwarded-For only for these hops
const TRUST_PROXY = process.env.TRUST_PROXY ?? '1';
app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY === 'true' ? true : TRUST_PROXY === 'false' ? false : TRUST_PROXY);

const HTTPS_PUBLIC = (process.env.PUBLIC_URL || '').startsWith('https://');
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: false,
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            // inline styles: index.html body style and the email preview (srcdoc iframe inherits this policy)
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
            fontSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            frameSrc: ["'self'"],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
            baseUri: ["'self'"],
            objectSrc: ["'none'"],
            ...(HTTPS_PUBLIC ? { upgradeInsecureRequests: [] } : {}),
        },
    },
    // HSTS only makes sense when the app is served over HTTPS
    strictTransportSecurity: HTTPS_PUBLIC ? { maxAge: 15552000 } : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '100kb' }));

// CSRF defence in depth (besides SameSite cookies): state-changing requests must come from this origin
app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
        let host = '';
        try {
            host = new URL(origin).host;
        } catch {
            // invalid Origin header
        }
        if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request blocked' });
    } else if (req.headers['sec-fetch-site'] === 'cross-site') {
        return res.status(403).json({ error: 'Cross-origin request blocked' });
    }
    next();
});

// Advanced: a custom MJML/Handlebars file replaces the email content edited in Settings
const EMAIL_TEMPLATE_PATH = process.env.EMAIL_TEMPLATE_PATH || '';
// OPNSENSE_HOST is preferred; HOSTNAME is kept for backward compatibility (in Kubernetes HOSTNAME is the pod name)
const OPNSENSE_HOST = process.env.OPNSENSE_HOST || process.env.HOSTNAME || (() => { throw new Error('OPNSENSE_HOST not set'); })();
const OPNSENSE_PORT = process.env.OPNSENSE_PORT ? Number(process.env.OPNSENSE_PORT) : undefined;
if (OPNSENSE_PORT !== undefined && !(Number.isInteger(OPNSENSE_PORT) && OPNSENSE_PORT > 0 && OPNSENSE_PORT < 65536))
    throw new Error(`Invalid OPNSENSE_PORT: '${process.env.OPNSENSE_PORT}'`);
const OPNSENSE_API_URL = `https://${OPNSENSE_HOST}${OPNSENSE_PORT ? `:${OPNSENSE_PORT}` : ''}/api/`;
const API_USERNAME = typeof process.env.API_USERNAME === 'string' ? process.env.API_USERNAME : (() => { throw new Error('API_USERNAME not set'); })();
const API_PASSWORD = typeof process.env.API_PASSWORD === 'string' ? process.env.API_PASSWORD : (() => { throw new Error('API_PASSWORD not set'); })();
const PROVIDER = typeof process.env.PROVIDER === 'string' ? process.env.PROVIDER : 'Voucher Server';
const ALLOW_SELFSIGNED_HTTPS = process.env.ALLOW_SELFSIGNED_HTTPS_CERTS === 'true';
const CAPTIVE_PORTAL_URL = typeof process.env.CAPTIVE_PORTAL_URL === 'string' ? process.env.CAPTIVE_PORTAL_URL : (() => { throw new Error('CAPTIVE_PORTAL_URL not set'); })();



const BASEPATH = process.env.BASEPATH ? process.env.BASEPATH.replace(/\/$/, "") : "";

if (BASEPATH)
    logger.info(`Using base path: '${BASEPATH || "/"}'`);

// Voucher history (SQLite) and admin settings
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const HISTORY_RETENTION_DAYS_DEFAULT = process.env.HISTORY_RETENTION_DAYS ? Number(process.env.HISTORY_RETENTION_DAYS) : 365;
if (!Number.isInteger(HISTORY_RETENTION_DAYS_DEFAULT) || HISTORY_RETENTION_DAYS_DEFAULT < 0)
    throw new Error(`Invalid HISTORY_RETENTION_DAYS: '${process.env.HISTORY_RETENTION_DAYS}'`);
const store = new Store(DATA_DIR);

// Email is optional: configured by SMTP_* env vars (read-only in the UI) or by an admin in Settings.
// Secrets stored in the database (SMTP password) are encrypted with SETTINGS_ENCRYPTION_KEY.
const secretBox = new SecretBox(process.env.SETTINGS_ENCRYPTION_KEY);
const emailConfig = new EmailConfig(process.env, store, secretBox);

const getRetentionDays = () => store.getSetting<number>('historyRetentionDays', HISTORY_RETENTION_DAYS_DEFAULT);
const getSyslogSettings = (): SyslogSettings => ({ ...defaultSyslogSettings, ...store.getSetting<Partial<SyslogSettings>>('syslog', {}) });

function purgeHistory() {
    try {
        const deleted = store.purgeHistory(getRetentionDays());
        if (deleted > 0) logger.info({ deleted }, 'Purged expired voucher history');
    } catch (err) {
        logger.error({ err }, 'Failed to purge voucher history');
    }
}
purgeHistory();
setInterval(purgeHistory, 3600 * 1000).unref();

// Sends an event to the syslog server configured by the admin (never blocks the request)
function emitSyslog(msgId: string, payload: Record<string, unknown>) {
    const settings = getSyslogSettings();
    if (!settings.enabled) return;
    sendSyslog(settings, msgId, payload).catch((err) => logger.error({ err }, 'Failed to send syslog event'));
}

// Liveness/readiness endpoint, reachable without login
app.get(`${BASEPATH}/healthz`, (_, res) => {
    res.json({ status: 'ok' });
});

// Login (AUTH_MODE: none | local | oidc | local+oidc): when enabled, the API below requires a session
const auth = new Auth(loadAuthConfig(process.env), BASEPATH, store, (event, data) => {
    logger.info({ event, ...data }, 'Audit');
    emitSyslog(event, { event, ...data });
});
setInterval(() => auth.purgeSessions(), 10 * 60000).unref();
auth.install(app);
auth.bootstrap().catch((err) => {
    logger.fatal({ err }, 'Failed to create the local admin user');
    process.exit(1);
});

const getEmailContent = (): EmailContent => ({ ...defaultEmailContent, ...store.getSetting<Partial<EmailContent>>('emailContent', {}) });

const QR_CID = 'voucher-qr@voucherbox';

// Legacy: custom MJML file with Handlebars variables (EMAIL_TEMPLATE_PATH)
async function renderLegacyTemplate(values: VoucherValues, qrSrc: string): Promise<RenderedEmail> {
    const source = fs.readFileSync(EMAIL_TEMPLATE_PATH, 'utf8');
    const compiled = handlebars.compile(source)({ ...values, qrCodeDataUrl: qrSrc, qrCode: qrSrc });
    const { html, errors } = await mjml2html(compiled);
    if (errors && errors.length > 0) throw new Error('MJML compilation error: ' + JSON.stringify(errors));
    return { html, text: '' };
}

async function renderEmail(content: EmailContent, values: VoucherValues, qrSrc: string | null): Promise<RenderedEmail> {
    return EMAIL_TEMPLATE_PATH ? renderLegacyTemplate(values, qrSrc ?? '') : renderVoucherEmail(content, values, qrSrc);
}

// Helper to clean up voucher groups
async function cleanupVoucherGroups(api: OpnsenseApi, provider: string): Promise<void> {
    let groupnames: string[];
    try {
        groupnames = await (await api.get(`captiveportal/voucher/list_voucher_groups/${provider}/`)).json() as string[];
        if (!groupnames) {
            logger.warn('No voucher groups found');
        }
        logger.debug({ groupnames }, 'Fetched voucher groups');
    } catch (e) {
        logger.error({ err: e }, 'Failed to list voucher groups');
        return;
    }
    for (const groupname of groupnames) {
        try {
            await api.post(`captiveportal/voucher/drop_expired_vouchers/${provider}/${encodeURIComponent(groupname)}/`);
            logger.debug({ groupname }, 'Dropped expired vouchers');
        } catch (e) {
            logger.warn({ groupname, err: e }, `Failed to drop expired vouchers for group ${groupname}`);
        }
    }
}

// Helper to send the voucher by email; the QR code is an inline attachment (cid:), Gmail blocks data: images
async function sendVoucherEmail(to: string, content: EmailContent, values: VoucherValues, qrPng: Buffer | null): Promise<void> {
    const cfg = emailConfig.effective();
    const { html, text } = await renderEmail(content, values, qrPng ? `cid:${QR_CID}` : null);
    const result = await sendMail(cfg, {
        to,
        bcc: cfg.admin || undefined,
        subject: cfg.subject,
        html,
        text: text || undefined,
        inlineImages: qrPng ? [{ cid: QR_CID, filename: 'wifi-qr.png', content: qrPng }] : undefined,
    });
    logger.info({ to, ...result }, 'Voucher email accepted by the SMTP server');
}

// Captive portal login link used by the QR code and the login button. OPNsense vouchers can contain
// characters like ? % & # [ ) that must be URL-encoded, otherwise the portal receives wrong credentials.
function buildLoginLink(username: string, password: string): string {
    const params = new URLSearchParams({ username, password, redirurl: 'www.msftconnecttest.com/redirect' });
    return `${CAPTIVE_PORTAL_URL.replace(/\/$/, '')}/index.html?${params.toString()}`;
}

const SAMPLE_VALUES = (c: EmailContent): VoucherValues => ({
    username: 'ab12cd34',
    password: 'Xy7kP2qR',
    validity: '4',
    expiryDate: formatDate(new Date(Date.now() + 4 * 3600 * 1000), c),
    loginLink: buildLoginLink('ab12cd34', 'Xy7kP2qR'),
});

const getLimits = (): Limits => ({ ...defaultLimits, ...store.getSetting<Partial<Limits>>('limits', {}) });

// Terms shown on the voucher page; the version shown/sent is recorded in the history
function currentTerms(c: EmailContent) {
    const text = c.terms.trim();
    return text
        ? { title: c.termsTitle, text, version: termsVersion(text), confirmation: c.termsConfirmation, confirmText: c.termsConfirmText }
        : null;
}

const EMAIL_ADDRESS_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

logger.info(emailConfig.managedByEnv
    ? 'Email delivery configured by environment (SMTP_HOST)'
    : `Email delivery ${emailConfig.enabled ? 'enabled' : 'disabled'} (configured in Settings)`);
if (!secretBox.available) logger.warn('SETTINGS_ENCRYPTION_KEY not set: the SMTP password cannot be stored from Settings');

app.get(`${BASEPATH}/api/config`, (_, res) => {
    res.json({ emailEnabled: emailConfig.enabled, terms: currentTerms(getEmailContent()), maxValidityDays: getLimits().maxValidityDays });
});

app.get(`${BASEPATH}/api/me`, (req, res) => {
    const user = getUser(req);
    res.json({
        authEnabled: auth.enabled,
        authModes: auth.modes,
        authenticated: !auth.enabled || !!user,
        user: user ? { name: user.name, email: user.email, source: user.source } : null,
        isAdmin: auth.isAdmin(user),
        session: auth.enabled ? auth.sessionPolicy : null,
    });
});

function historyQuery(req: express.Request): HistoryQuery {
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
    const num = (v: unknown) => (typeof v === 'string' && v !== '' && !isNaN(Number(v)) ? Number(v) : undefined);
    return { q: str(req.query.q), from: str(req.query.from), to: str(req.query.to), limit: num(req.query.limit), offset: num(req.query.offset) };
}

app.get(`${BASEPATH}/api/history`, auth.requireAdmin(), (req, res) => {
    res.json(store.queryHistory(historyQuery(req)));
});

// CSV export; cells starting with = + - @ are prefixed to avoid formula injection in spreadsheets
app.get(`${BASEPATH}/api/history.csv`, auth.requireAdmin(), (req, res) => {
    const { items } = store.queryHistory({ ...historyQuery(req), limit: 10000, offset: 0 });
    const cell = (v: unknown) => {
        let s = v === null || v === undefined ? '' : String(v);
        if (/^[=+\-@]/.test(s)) s = `'${s}`;
        return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['createdAt', 'username', 'vouchergroup', 'provider', 'validityHours', 'expiresAt', 'email', 'emailSent', 'emailError', 'operator', 'termsAccepted', 'termsVersion'];
    const lines = [header.join(','), ...items.map((e) => header.map((h) => cell(e[h as keyof HistoryEntry])).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="voucher-history-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
});

const settingsView = () => ({
    syslog: getSyslogSettings(),
    email: emailConfig.view(),
    emailContent: getEmailContent(),
    emailTemplateManagedByEnv: !!EMAIL_TEMPLATE_PATH,
    placeholders: PLACEHOLDERS,
    historyRetentionDays: getRetentionDays(),
    historyRetentionDaysDefault: HISTORY_RETENTION_DAYS_DEFAULT,
    limits: getLimits(),
});

app.get(`${BASEPATH}/api/settings`, auth.requireAdmin(), (_, res) => {
    res.json(settingsView());
});

// SMTP password in a request: undefined = keep the stored one, '' = remove, string = replace
function passwordField(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined;
}

function parseSyslogSettings(body: unknown): SyslogSettings {
    const b = (body ?? {}) as Partial<SyslogSettings>;
    return {
        ...defaultSyslogSettings,
        enabled: b.enabled === true,
        host: typeof b.host === 'string' ? b.host.trim() : '',
        port: Number(b.port ?? defaultSyslogSettings.port),
        protocol: (b.protocol ?? defaultSyslogSettings.protocol) as SyslogSettings['protocol'],
        facility: Number(b.facility ?? defaultSyslogSettings.facility),
        appName: typeof b.appName === 'string' && b.appName.trim() ? b.appName.trim() : defaultSyslogSettings.appName,
        hostname: typeof b.hostname === 'string' ? b.hostname.trim() : '',
        allowSelfSigned: b.allowSelfSigned === true,
    };
}

app.put(`${BASEPATH}/api/settings`, auth.requireAdmin(), (req, res) => {
    const body = (req.body ?? {}) as { syslog?: unknown; email?: { password?: unknown }; historyRetentionDays?: unknown };

    // validate everything first, then save: a bad section must not leave a partial update
    let syslog: SyslogSettings | undefined;
    if (body.syslog !== undefined) {
        syslog = parseSyslogSettings(body.syslog);
        const error = validateSyslogSettings(syslog);
        if (error) return res.status(400).json({ error: `Syslog: ${error}` });
    }
    let email: EmailSettings | undefined;
    const emailPassword = passwordField(body.email?.password);
    if (body.email !== undefined && !emailConfig.managedByEnv) {
        email = parseEmailSettings(body.email);
        const error = validateEmailSettings(email);
        if (error) return res.status(400).json({ error: `Email: ${error}` });
        if (emailPassword && !secretBox.available) {
            return res.status(400).json({ error: 'Email: SETTINGS_ENCRYPTION_KEY is not set, the SMTP password cannot be stored' });
        }
    }
    let content: EmailContent | undefined;
    const bodyContent = (req.body ?? {}).emailContent;
    if (bodyContent !== undefined) {
        content = parseEmailContent(bodyContent);
        const error = validateEmailContent(content);
        if (error) return res.status(400).json({ error: `Email content: ${error}` });
    }
    let limits: Limits | undefined;
    const bodyLimits = (req.body ?? {}).limits;
    if (bodyLimits !== undefined) {
        limits = parseLimits(bodyLimits);
        const error = validateLimits(limits);
        if (error) return res.status(400).json({ error: `Limits: ${error}` });
    }
    let days: number | undefined;
    if (body.historyRetentionDays !== undefined) {
        days = Number(body.historyRetentionDays);
        if (!Number.isInteger(days) || days < 0) return res.status(400).json({ error: 'historyRetentionDays must be an integer >= 0' });
    }

    if (syslog) store.setSetting('syslog', syslog);
    if (email) emailConfig.save(email, emailPassword);
    if (content) {
        store.setSetting('emailContent', content);
        const terms = currentTerms(content);
        if (terms) store.saveTermsVersion(terms.version, terms.text);
    }
    if (limits) store.setSetting('limits', limits);
    if (days !== undefined) {
        store.setSetting('historyRetentionDays', days);
        purgeHistory();
    }
    const operator = getUser(req)?.name ?? null;
    logger.info({ operator }, 'Settings updated');
    emitSyslog('settings.updated', { event: 'settings.updated', operator, sections: Object.keys(body) });
    res.json(settingsView());
});

// Sends a test email with the settings from the form (not necessarily saved); the stored password is used if none is given
app.post(`${BASEPATH}/api/settings/email/test`, auth.requireAdmin(), asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { to?: unknown; password?: unknown };
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) return res.status(400).json({ error: 'A valid recipient is required' });
    let cfg;
    try {
        const form = { ...parseEmailSettings(req.body), enabled: true };
        const error = emailConfig.managedByEnv ? null : validateEmailSettings(form);
        if (error) return res.status(400).json({ error });
        cfg = emailConfig.fromForm(form, passwordField(body.password));
    } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
    }
    try {
        const result = await sendMail(cfg, {
            to,
            subject: 'VoucherBox test email',
            html: `<p>This is a test email from VoucherBox, sent by ${getUser(req)?.name ?? 'an admin'}.</p><p>SMTP: ${cfg.host}:${cfg.port}</p>`,
        });
        logger.info({ to, operator: getUser(req)?.name, ...result }, 'Test email accepted by the SMTP server');
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(502).json({ error: (err as Error).message });
    }
}));

// Sends a test message with the settings from the form (not necessarily saved)
app.post(`${BASEPATH}/api/settings/syslog/test`, auth.requireAdmin(), asyncHandler(async (req, res) => {
    const syslog = { ...parseSyslogSettings(req.body), enabled: true };
    const error = validateSyslogSettings(syslog);
    if (error) return res.status(400).json({ error });
    try {
        await sendSyslog(syslog, 'test', { event: 'test', message: 'VoucherBox syslog test', operator: getUser(req)?.name ?? null });
        res.json({ success: true });
    } catch (err) {
        res.status(502).json({ error: (err as Error).message });
    }
}));

// Renders the email content from the form with sample voucher data (QR as data: URL for the browser)
app.post(`${BASEPATH}/api/settings/email/preview`, auth.requireAdmin(), asyncHandler(async (req, res) => {
    const content = parseEmailContent(req.body);
    const error = validateEmailContent(content);
    if (error) return res.status(400).json({ error });
    const values = SAMPLE_VALUES(content);
    const { html, text } = await renderEmail(content, values, await QRCode.toDataURL(values.loginLink));
    res.json({ html, text });
}));

// Sends a sample voucher email with the content from the form and the saved SMTP settings
app.post(`${BASEPATH}/api/settings/email/sample`, auth.requireAdmin(), asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { to?: unknown; content?: unknown };
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) return res.status(400).json({ error: 'A valid recipient is required' });
    if (!emailConfig.enabled) return res.status(400).json({ error: 'Email is not enabled: save the SMTP settings first' });
    const content = parseEmailContent(body.content);
    const error = validateEmailContent(content);
    if (error) return res.status(400).json({ error });
    const values = SAMPLE_VALUES(content);
    try {
        await sendVoucherEmail(to, content, values, content.showQr ? await QRCode.toBuffer(values.loginLink) : null);
        res.json({ success: true });
    } catch (err) {
        res.status(502).json({ error: (err as Error).message });
    }
}));

// Exact text of a terms version recorded in the history
app.get(`${BASEPATH}/api/terms/:version`, auth.requireAdmin(), (req, res) => {
    const v = store.getTermsVersion(String(req.params.version));
    if (!v) return res.status(404).json({ error: 'Terms version not found' });
    res.json(v);
});

app.post(`${BASEPATH}/api/createvoucher`,
    asyncHandler(async (req, res) => {
        const body = (req.body ?? {}) as { email?: unknown; validity?: unknown; expirytime?: unknown; termsAccepted?: unknown };
        const limits = getLimits();
        const maxSeconds = limits.maxValidityDays * 86400;

        // Server-side validation: never trust the browser
        const validity = body.validity === undefined ? 14400 : Number(body.validity);
        if (!Number.isInteger(validity) || validity < 3600 || validity > maxSeconds) {
            return res.status(400).json({ error: `Validity must be between 1 hour and ${limits.maxValidityDays} days` });
        }
        // expirytime: seconds after which the voucher expires even if unused (0 = none)
        const expirytime = body.expirytime === undefined ? Math.min(86400, maxSeconds) : Number(body.expirytime);
        if (!Number.isInteger(expirytime) || expirytime < 0 || expirytime > maxSeconds) {
            return res.status(400).json({ error: `The end date must be within ${limits.maxValidityDays} days` });
        }
        let email: string | undefined;
        if (body.email !== undefined && body.email !== null && body.email !== '') {
            if (typeof body.email !== 'string' || body.email.length > 254 || !EMAIL_ADDRESS_RE.test(body.email.trim())) {
                return res.status(400).json({ error: 'Invalid email address' });
            }
            email = body.email.trim();
        }

        // Terms: always recorded when configured; the operator confirmation is optional (Settings)
        const content = getEmailContent();
        const terms = currentTerms(content);
        if (terms?.confirmation && body.termsAccepted !== true) {
            return res.status(400).json({ error: `Please confirm: "${terms.confirmText}"` });
        }

        // Abuse limits, checked before calling OPNsense
        const operatorName = getUser(req)?.name ?? null;
        const limitError = checkLimits(store, limits, operatorName, emailConfig.enabled ? email ?? null : null);
        if (limitError) {
            logger.warn({ operator: operatorName, reason: limitError }, 'Voucher creation rate limited');
            emitSyslog('voucher.rate_limited', { event: 'voucher.rate_limited', operator: operatorName, reason: limitError, ip: req.ip });
            return res.status(429).json({ error: limitError });
        }
        if (terms) store.saveTermsVersion(terms.version, terms.text);


        const vouchergroup = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const api = new OpnsenseApi(
            {
                baseUrl: OPNSENSE_API_URL,
                username: API_USERNAME,
                password: API_PASSWORD,
                allowSelfSigned: ALLOW_SELFSIGNED_HTTPS
            });

        try {
            logger.debug({ email, validity, expirytime, vouchergroup, PROVIDER }, 'Generating voucher');

            // encode provider for usage in URLs
            const provider = encodeURIComponent(PROVIDER);

            // Create voucher through opnsense API
            const response = await api.post(`captiveportal/voucher/generate_vouchers/${provider}/`, {
                count: '1',
                validity: String(validity),
                expirytime: String(expirytime),
                vouchergroup
            });
            const vouchers = await response.json() as Voucher[];
            logger.debug({ vouchers }, 'Voucher API response');

            // Check if voucher was created
            if (!vouchers || vouchers.length === 0) {
                logger.error('Voucher generation failed');
                return res.status(500).json({ error: 'Voucher generation failed' });
            }

            const voucher = vouchers[0];

            // Generate login link and QR code
            const loginLink = buildLoginLink(voucher.username, voucher.password);
            let qrCodeDataUrl = '';
            let qrPng: Buffer | null = null;
            try {
                qrCodeDataUrl = await QRCode.toDataURL(loginLink);
                qrPng = await QRCode.toBuffer(loginLink);
            } catch (err) {
                logger.warn({ err }, 'Failed to generate QR code');
            }

            const expirySecondsValue = Number(voucher.expirytime);
            const values: VoucherValues = {
                username: voucher.username,
                password: voucher.password,
                validity: String(Number(voucher.validity) / 3600),
                expiryDate: expirySecondsValue > 0 ? formatDate(new Date(expirySecondsValue * 1000), content) : '',
                loginLink,
            };

            // The voucher already exists in OPNsense: an email failure must not hide it
            let emailSent = false;
            let emailError: string | undefined;
            if (emailConfig.enabled && email) {
                try {
                    await sendVoucherEmail(email, content, values, content.showQr ? qrPng : null);
                    emailSent = true;
                } catch (err) {
                    emailError = (err as Error).message;
                    logger.error({ err }, 'Failed to send voucher email');
                }
            }

            // Clean up old voucher groups
            await cleanupVoucherGroups(api, provider);

            // History and syslog: everything except the voucher password
            const expirySeconds = Number(voucher.expirytime);
            const entry = {
                username: voucher.username,
                vouchergroup,
                provider: PROVIDER,
                validityHours: Number(voucher.validity) / 3600,
                expiresAt: expirySeconds > 0 ? new Date(expirySeconds * 1000).toISOString() : null,
                email: email || null,
                emailSent,
                emailError: emailError ?? null,
                operator: getUser(req)?.name ?? null,
                termsAccepted: terms?.confirmation ? true : null,
                termsVersion: terms?.version ?? null,
            };
            try {
                store.addHistory(entry);
            } catch (err) {
                logger.error({ err }, 'Failed to write voucher history');
            }
            emitSyslog('voucher.created', { event: 'voucher.created', ...entry });

            res.json({ success: true, voucher, qrCodeDataUrl, loginLink, emailSent, emailError });
            logger.info({ username: voucher.username, vouchergroup, emailSent, operator: entry.operator }, 'Voucher created');
        } catch (err: unknown) {
            logger.error({ err }, 'Error in /api/createvoucher');
            res.status(500).json({ error: (err as Error).message });
        }
    }));

const env = (process.env.NODE_ENV ?? "development").toLowerCase();

logger.info(`Running in ${env} mode`);

// --- Serve frontend only in production ---
if (env === "production") {
    logger.info("Serving static HTML content...")

    const frontendPath = path.join(__dirname, "../frontend/"); // vite default output
    app.use(BASEPATH, express.static(frontendPath));

    // any non react route or non api, send to index.html
    app.get(`${BASEPATH}/*splat`, (_, res) => {
        res.sendFile(path.join(frontendPath, "index.html"));
    });
}

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});
