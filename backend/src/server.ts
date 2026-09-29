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
app.use(express.json());

const EMAIL_TEMPLATE_PATH = typeof process.env.EMAIL_TEMPLATE_PATH === 'string' ? process.env.EMAIL_TEMPLATE_PATH : "emailtemplate.mjml";
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
const auth = new Auth(loadAuthConfig(process.env), BASEPATH, store);
auth.install(app);
auth.bootstrap().catch((err) => {
    logger.fatal({ err }, 'Failed to create the local admin user');
    process.exit(1);
});

// Helper to compile MJML template and generate HTML
async function compileVoucherEmail(vouchertmp: unknown): Promise<{ html: string; error?: string }> {
    let mjmlSource;
    try {
        mjmlSource = fs.readFileSync(EMAIL_TEMPLATE_PATH, 'utf8');
    } catch {
        return { html: '', error: 'Failed to read MJML template file' };
    }
    let mjmlCompiled;
    try {
        mjmlCompiled = handlebars.compile(mjmlSource)(vouchertmp);
    } catch {
        return { html: '', error: 'Failed to compile MJML template with variables' };
    }
    const { html, errors } = await mjml2html(mjmlCompiled);
    if (errors && errors.length > 0) {
        return { html: '', error: 'MJML compilation error: ' + JSON.stringify(errors) };
    }
    return { html };
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

// Helper to send the voucher by email
async function sendVoucherEmail(email: string, vouchertmp: unknown): Promise<void> {
    const cfg = emailConfig.effective();
    // Compile MJML template and generate HTML
    const { html, error } = await compileVoucherEmail(vouchertmp);
    if (error) {
        throw new Error(error);
    }
    logger.debug({ html }, 'Prepared email HTML');
    await sendMail(cfg, { to: email, bcc: cfg.admin || undefined, subject: cfg.subject, html });
    logger.debug({ to: email }, 'Sent voucher email');
}

logger.info(emailConfig.managedByEnv
    ? 'Email delivery configured by environment (SMTP_HOST)'
    : `Email delivery ${emailConfig.enabled ? 'enabled' : 'disabled'} (configured in Settings)`);
if (!secretBox.available) logger.warn('SETTINGS_ENCRYPTION_KEY not set: the SMTP password cannot be stored from Settings');

app.get(`${BASEPATH}/api/config`, (_, res) => {
    res.json({ emailEnabled: emailConfig.enabled });
});

app.get(`${BASEPATH}/api/me`, (req, res) => {
    const user = getUser(req);
    res.json({
        authEnabled: auth.enabled,
        authModes: auth.modes,
        authenticated: !auth.enabled || !!user,
        user: user ? { name: user.name, email: user.email, source: user.source } : null,
        isAdmin: auth.isAdmin(user),
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
    const header = ['createdAt', 'username', 'vouchergroup', 'provider', 'validityHours', 'expiresAt', 'email', 'emailSent', 'emailError', 'operator'];
    const lines = [header.join(','), ...items.map((e) => header.map((h) => cell(e[h as keyof HistoryEntry])).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="voucher-history-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
});

const settingsView = () => ({
    syslog: getSyslogSettings(),
    email: emailConfig.view(),
    historyRetentionDays: getRetentionDays(),
    historyRetentionDaysDefault: HISTORY_RETENTION_DAYS_DEFAULT,
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
    let days: number | undefined;
    if (body.historyRetentionDays !== undefined) {
        days = Number(body.historyRetentionDays);
        if (!Number.isInteger(days) || days < 0) return res.status(400).json({ error: 'historyRetentionDays must be an integer >= 0' });
    }

    if (syslog) store.setSetting('syslog', syslog);
    if (email) emailConfig.save(email, emailPassword);
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
        await sendMail(cfg, {
            to,
            subject: 'VoucherBox test email',
            html: `<p>This is a test email from VoucherBox, sent by ${getUser(req)?.name ?? 'an admin'}.</p><p>SMTP: ${cfg.host}:${cfg.port}</p>`,
        });
        logger.info({ to, operator: getUser(req)?.name }, 'Test email sent');
        res.json({ success: true });
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

app.post(`${BASEPATH}/api/createvoucher`,
    asyncHandler(async (req, res) => {
        const { email, validity = 14400, expirytime = Date.now() + 86400000 }
            = (req.body ?? {}) as { email?: string; validity?: number; expirytime?: number };


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
            const loginLink = `${CAPTIVE_PORTAL_URL}/index.html?username=${voucher.username}&password=${voucher.password}&redirurl=www.msftconnecttest.com/redirect`;
            let qrCodeDataUrl = '';
            try {
                qrCodeDataUrl = await QRCode.toDataURL(loginLink);
            } catch (err) {
                logger.warn({ err }, 'Failed to generate QR code');
            }

            logger.debug({ qrCodeDataUrl }, 'Generated QR code data URL');

            // Prepare voucher data for email template
            const vouchertmp = {
                ...voucher,
                expiryDate: new Date(Number(voucher.expirytime) * 1000).toLocaleString(),
                validity: Number(voucher.validity) / 60 / 60,
                loginLink,
                qrCodeDataUrl
            };

            // The voucher already exists in OPNsense: an email failure must not hide it
            let emailSent = false;
            let emailError: string | undefined;
            if (emailConfig.enabled && email) {
                try {
                    await sendVoucherEmail(email, vouchertmp);
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
