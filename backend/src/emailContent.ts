import crypto from 'crypto';
import mjml2html from 'mjml';

// Voucher email built from admin-editable text fields on a fixed, email-client friendly layout.
// Text is plain text: HTML is escaped, only the placeholders below are substituted.

export interface EmailContent {
    title: string;
    intro: string;
    instructions: string;
    signature: string;
    termsTitle: string;
    // Terms and conditions: shown in the email and on the voucher page (acceptance is recorded)
    terms: string;
    labelUsername: string;
    labelPassword: string;
    labelValidity: string;
    labelHours: string;
    labelExpiry: string;
    showQr: boolean;
    qrCaption: string;
    // A clickable link to the captive portal with the password in the URL looks like phishing to spam filters
    showLoginButton: boolean;
    loginButtonText: string;
    // Date formatting, e.g. "it-IT" and "Europe/Rome"
    locale: string;
    timeZone: string;
}

export const defaultEmailContent: EmailContent = {
    title: 'Your WiFi voucher',
    intro: 'Hello,\nhere are your WiFi access details.',
    instructions: '1. Connect to the WiFi network.\n2. When the login page opens, enter the username and password, or scan the QR code.',
    signature: 'Thank you and enjoy your stay.',
    termsTitle: 'Terms and conditions',
    terms: '',
    labelUsername: 'Username',
    labelPassword: 'Password',
    labelValidity: 'Valid for',
    labelHours: 'hours',
    labelExpiry: 'Expires',
    showQr: true,
    qrCaption: 'Scan with your phone after connecting to the WiFi.',
    showLoginButton: false,
    loginButtonText: 'Log in to the WiFi',
    locale: 'en-GB',
    timeZone: 'UTC',
};

export const PLACEHOLDERS = ['username', 'password', 'validity', 'expiryDate', 'loginLink'] as const;
export type VoucherValues = Record<(typeof PLACEHOLDERS)[number], string>;

const TEXT_FIELDS: (keyof EmailContent)[] = [
    'title', 'intro', 'instructions', 'signature', 'termsTitle', 'terms',
    'labelUsername', 'labelPassword', 'labelValidity', 'labelHours', 'labelExpiry', 'qrCaption', 'loginButtonText',
];

export function parseEmailContent(body: unknown): EmailContent {
    const b = (body ?? {}) as Partial<Record<keyof EmailContent, unknown>>;
    const out = { ...defaultEmailContent };
    for (const k of TEXT_FIELDS) {
        const v = b[k];
        if (typeof v === 'string') (out as Record<string, unknown>)[k] = v.replace(/\r\n/g, '\n');
    }
    out.showQr = b.showQr === undefined ? defaultEmailContent.showQr : b.showQr === true;
    out.showLoginButton = b.showLoginButton === true;
    if (typeof b.locale === 'string') out.locale = b.locale.trim();
    if (typeof b.timeZone === 'string') out.timeZone = b.timeZone.trim();
    return out;
}

export function validateEmailContent(c: EmailContent): string | null {
    for (const k of TEXT_FIELDS) {
        const v = c[k] as string;
        const max = k === 'terms' ? 20000 : 2000;
        if (v.length > max) return `${k} is too long (max ${max} characters)`;
        const unknown = [...v.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]).filter((p) => !(PLACEHOLDERS as readonly string[]).includes(p));
        if (unknown.length) return `${k}: unknown placeholder {{${unknown[0]}}}. Available: ${PLACEHOLDERS.map((p) => `{{${p}}}`).join(' ')}`;
    }
    try {
        new Intl.DateTimeFormat(c.locale || undefined, { timeZone: c.timeZone || undefined }).format(new Date());
    } catch {
        return `Invalid locale "${c.locale}" or time zone "${c.timeZone}"`;
    }
    return null;
}

export function formatDate(date: Date, c: EmailContent): string {
    return new Intl.DateTimeFormat(c.locale || undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: c.timeZone || undefined }).format(date);
}

// Version id of the terms text, recorded in the history when the guest accepts them
export function termsVersion(terms: string): string {
    return crypto.createHash('sha256').update(terms.trim(), 'utf8').digest('hex').slice(0, 12);
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function fill(text: string, values: VoucherValues): string {
    return text.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (m, name: string) => (name in values ? values[name as keyof VoucherValues] : m));
}

// Plain text -> escaped HTML with line breaks
function html(text: string, values: VoucherValues): string {
    return escapeHtml(fill(text, values)).replace(/\n/g, '<br/>');
}

export interface RenderedEmail {
    html: string;
    text: string;
}

// qrSrc: "cid:..." for emails (inline attachment), a data: URL for the admin preview
export async function renderVoucherEmail(c: EmailContent, values: VoucherValues, qrSrc: string | null): Promise<RenderedEmail> {
    const row = (label: string, value: string) =>
        `<tr><td style="background:#f1f5f9;padding:10px 14px;border-radius:6px;font-size:16px;"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</td></tr><tr><td style="height:6px"></td></tr>`;
    const text = (t: string, attrs: string) => (t.trim() ? `<mj-text ${attrs}>${html(t, values)}</mj-text>` : '');

    const mjml = `<mjml>
  <mj-head>
    <mj-title>${escapeHtml(fill(c.title, values))}</mj-title>
    <mj-attributes><mj-all font-family="Arial, Helvetica, sans-serif" /></mj-attributes>
  </mj-head>
  <mj-body background-color="#f3f4f6">
    <mj-section>
      <mj-column background-color="#ffffff" border-radius="12px" padding="28px 20px">
        ${text(c.title, 'font-size="24px" color="#2563eb" font-weight="700" padding-bottom="16px"')}
        ${text(c.intro, 'font-size="16px" line-height="24px" padding-bottom="16px"')}
        <mj-table>
          ${row(c.labelUsername, values.username)}
          ${row(c.labelPassword, values.password)}
          ${row(c.labelValidity, `${values.validity} ${c.labelHours}`)}
          ${values.expiryDate ? row(c.labelExpiry, values.expiryDate) : ''}
        </mj-table>
        ${c.showQr && qrSrc ? `<mj-image src="${escapeHtml(qrSrc)}" alt="QR code" width="160px" padding-top="16px" />` : ''}
        ${c.showQr && qrSrc ? text(c.qrCaption, 'font-size="13px" color="#64748b" align="center"') : ''}
        ${c.showLoginButton ? `<mj-button background-color="#2563eb" color="#ffffff" border-radius="6px" font-size="16px" font-weight="600" href="${escapeHtml(values.loginLink)}" padding-top="16px">${escapeHtml(fill(c.loginButtonText, values))}</mj-button>` : ''}
        ${text(c.instructions, 'font-size="15px" line-height="22px" padding-top="16px"')}
        ${text(c.signature, 'font-size="15px" color="#334155" padding-top="16px"')}
        ${c.terms.trim() ? `<mj-divider border-width="1px" border-color="#e2e8f0" padding-top="20px" />
        ${text(c.termsTitle, 'font-size="13px" font-weight="700" color="#475569"')}
        ${text(c.terms, 'font-size="12px" line-height="18px" color="#64748b"')}` : ''}
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

    const { html: out, errors } = await mjml2html(mjml, { validationLevel: 'soft' });
    if (errors && errors.length > 0) throw new Error('Email template error: ' + errors.map((e) => e.formattedMessage).join('; '));

    const lines = [
        fill(c.title, values),
        '',
        fill(c.intro, values),
        '',
        `${c.labelUsername}: ${values.username}`,
        `${c.labelPassword}: ${values.password}`,
        `${c.labelValidity}: ${values.validity} ${c.labelHours}`,
        ...(values.expiryDate ? [`${c.labelExpiry}: ${values.expiryDate}`] : []),
        '',
        ...(c.showLoginButton ? [`${fill(c.loginButtonText, values)}: ${values.loginLink}`, ''] : []),
        fill(c.instructions, values),
        '',
        fill(c.signature, values),
        ...(c.terms.trim() ? ['', '---', fill(c.termsTitle, values), fill(c.terms, values)] : []),
    ];
    return { html: out, text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n' };
}
