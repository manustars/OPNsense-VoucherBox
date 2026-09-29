import nodemailer from 'nodemailer';
import { Store } from './db';
import { SecretBox } from './secrets';

// SMTP configuration: from the environment (SMTP_HOST set = managed by the deployment, read-only in the UI)
// or from the admin Settings page (stored in the database, password encrypted with SecretBox).

export interface EmailSettings {
    enabled: boolean;
    host: string;
    port: number;
    // true = implicit TLS (port 465); false = plain/STARTTLS (587)
    tls: boolean;
    user: string;
    from: string;
    // BCC address for every voucher email
    admin: string;
    subject: string;
}

export interface EffectiveEmail extends EmailSettings {
    source: 'env' | 'settings';
    password: string;
}

// What the Settings page receives: never the password
export interface EmailSettingsView extends EmailSettings {
    source: 'env' | 'settings';
    passwordSet: boolean;
    encryptionAvailable: boolean;
}

const DEFAULTS: EmailSettings = {
    enabled: false,
    host: '',
    port: 587,
    tls: false,
    user: '',
    from: '',
    admin: '',
    subject: 'Your Voucher Details',
};

const KEY = 'email';
const PASSWORD_KEY = 'emailPasswordEnc';

export class EmailConfig {
    private env?: EffectiveEmail;

    constructor(envVars: NodeJS.ProcessEnv, private store: Store, private box: SecretBox) {
        if (envVars.SMTP_HOST) {
            const env: EffectiveEmail = {
                source: 'env',
                enabled: true,
                host: envVars.SMTP_HOST,
                port: envVars.SMTP_PORT ? Number(envVars.SMTP_PORT) : 587,
                tls: envVars.SMTP_TLS === 'true',
                user: envVars.SMTP_USER || '',
                password: envVars.SMTP_PASS || '',
                from: envVars.SMTP_FROM || '',
                admin: envVars.EMAIL_ADMIN || '',
                subject: envVars.EMAIL_SUBJECT || DEFAULTS.subject,
            };
            const err = validateEmailSettings(env);
            if (err) throw new Error(`SMTP configuration from environment: ${err}`);
            this.env = env;
        }
    }

    get managedByEnv(): boolean {
        return !!this.env;
    }

    private stored(): EmailSettings {
        return { ...DEFAULTS, ...this.store.getSetting<Partial<EmailSettings>>(KEY, {}) };
    }

    // Effective configuration used to send; throws if the stored password cannot be decrypted
    effective(): EffectiveEmail {
        if (this.env) return this.env;
        const s = this.stored();
        const enc = this.store.getSetting<string>(PASSWORD_KEY, '');
        return { ...s, source: 'settings', password: enc ? this.box.decrypt(enc) : '' };
    }

    get enabled(): boolean {
        return this.env ? true : this.stored().enabled;
    }

    view(): EmailSettingsView {
        if (this.env) {
            const { password, ...rest } = this.env;
            return { ...rest, passwordSet: !!password, encryptionAvailable: this.box.available };
        }
        return {
            ...this.stored(),
            source: 'settings',
            passwordSet: !!this.store.getSetting<string>(PASSWORD_KEY, ''),
            encryptionAvailable: this.box.available,
        };
    }

    // password: undefined = keep the stored one, '' = remove it, otherwise replace it
    save(settings: EmailSettings, password: string | undefined): void {
        if (this.env) throw new Error('SMTP is managed by the deployment (SMTP_HOST is set)');
        if (password !== undefined && password !== '') this.store.setSetting(PASSWORD_KEY, this.box.encrypt(password));
        else if (password === '') this.store.setSetting(PASSWORD_KEY, '');
        this.store.setSetting(KEY, settings);
    }

    // Builds an EffectiveEmail from a form (for the test button) using the stored password when none is given
    fromForm(settings: EmailSettings, password: string | undefined): EffectiveEmail {
        if (this.env) return this.env;
        let pass = password ?? '';
        if (password === undefined) {
            const enc = this.store.getSetting<string>(PASSWORD_KEY, '');
            pass = enc ? this.box.decrypt(enc) : '';
        }
        return { ...settings, source: 'settings', password: pass };
    }
}

export function parseEmailSettings(body: unknown): EmailSettings {
    const b = (body ?? {}) as Partial<Record<keyof EmailSettings, unknown>>;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    return {
        enabled: b.enabled === true,
        host: str(b.host),
        port: Number(b.port ?? DEFAULTS.port),
        tls: b.tls === true,
        user: str(b.user),
        from: str(b.from),
        admin: str(b.admin),
        subject: str(b.subject) || DEFAULTS.subject,
    };
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function validateEmailSettings(s: EmailSettings): string | null {
    if (!s.enabled) return null;
    if (!s.host) return 'SMTP host is required';
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return 'SMTP port must be between 1 and 65535';
    if (!s.from && !s.user) return 'Sender (from) or SMTP user is required';
    if (s.admin && !EMAIL_RE.test(s.admin)) return 'BCC address is not a valid email';
    if (s.subject.length > 200) return 'Subject is too long';
    return null;
}

export async function sendMail(cfg: EffectiveEmail, message: { to: string; subject: string; html: string; bcc?: string }): Promise<void> {
    const transporter = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.tls,
        // no user = relay without authentication
        auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
    });
    await transporter.sendMail({
        from: cfg.from || cfg.user,
        to: message.to,
        bcc: message.bcc,
        subject: message.subject,
        html: message.html,
    });
}
