import express from 'express';
import nodemailer from 'nodemailer';
import handlebars from 'handlebars';
import mjml2html from 'mjml';
import fs from 'fs';
import dotenv from 'dotenv';
import pino from 'pino';
import { OpnsenseApi } from './OpnsenseApi';
import { Voucher } from './Models';
import { asyncHandler } from './expressUtils';
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

// Email delivery is optional: it is enabled only when SMTP_HOST is set
const SMTP_HOST = process.env.SMTP_HOST || '';
const EMAIL_ENABLED = SMTP_HOST !== '';
const EMAIL_ADMIN = process.env.EMAIL_ADMIN || undefined;
const EMAIL_SUBJECT = typeof process.env.EMAIL_SUBJECT === 'string' ? process.env.EMAIL_SUBJECT : 'Your Voucher Details';
const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : (EMAIL_ENABLED ? (() => { throw new Error('SMTP_PORT not set'); })() : 0);
const SMTP_USER = typeof process.env.SMTP_USER === 'string' ? process.env.SMTP_USER : (EMAIL_ENABLED ? (() => { throw new Error('SMTP_USER not set'); })() : '');
const SMTP_PASS = typeof process.env.SMTP_PASS === 'string' ? process.env.SMTP_PASS : (EMAIL_ENABLED ? (() => { throw new Error('SMTP_PASS not set'); })() : '');
const SMTP_FROM = typeof process.env.SMTP_FROM === 'string' && process.env.SMTP_FROM !== '' ? process.env.SMTP_FROM : SMTP_USER;
const SMTP_TLS = process.env.SMTP_TLS === 'true';
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
    // Compile MJML template and generate HTML
    const { html, error } = await compileVoucherEmail(vouchertmp);
    if (error) {
        throw new Error(error);
    }
    logger.debug({ html }, 'Prepared email HTML');

    const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_TLS,
        auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    await transporter.sendMail({
        from: SMTP_FROM,
        to: email,
        bcc: EMAIL_ADMIN,
        subject: EMAIL_SUBJECT,
        html
    });
    logger.debug({ to: email }, 'Sent voucher email');
}

logger.info(`Email delivery ${EMAIL_ENABLED ? 'enabled' : 'disabled (SMTP_HOST not set)'}`);

app.get(`${BASEPATH}/api/config`, (_, res) => {
    res.json({ emailEnabled: EMAIL_ENABLED });
});

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
            if (EMAIL_ENABLED && email) {
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

            res.json({ success: true, voucher, qrCodeDataUrl, loginLink, emailSent, emailError });
            logger.info({ username: voucher.username, vouchergroup, emailSent }, 'Voucher created');
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
