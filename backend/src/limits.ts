import { Store } from './db';

// Abuse limits for voucher creation (0 = unlimited). Counted from the history, so they survive restarts.

export interface Limits {
    vouchersPerUserHour: number;
    vouchersPerUserDay: number;
    emailsPerUserHour: number;
    emailsPerRecipientDay: number;
    vouchersPerInstanceDay: number;
    // maximum voucher validity and expiry window
    maxValidityDays: number;
}

export const defaultLimits: Limits = {
    vouchersPerUserHour: 10,
    vouchersPerUserDay: 50,
    emailsPerUserHour: 10,
    emailsPerRecipientDay: 2,
    vouchersPerInstanceDay: 150,
    maxValidityDays: 7,
};

export function parseLimits(body: unknown): Limits {
    const b = (body ?? {}) as Partial<Record<keyof Limits, unknown>>;
    const out = { ...defaultLimits };
    for (const k of Object.keys(defaultLimits) as (keyof Limits)[]) {
        if (b[k] !== undefined) out[k] = Number(b[k]);
    }
    return out;
}

export function validateLimits(l: Limits): string | null {
    for (const [k, v] of Object.entries(l)) {
        if (!Number.isInteger(v) || v < 0 || v > 100000) return `${k} must be an integer between 0 and 100000`;
    }
    if (l.maxValidityDays < 1 || l.maxValidityDays > 366) return 'maxValidityDays must be between 1 and 366';
    return null;
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Returns a message when creating a voucher (and optionally sending it to `email`) would exceed a limit
export function checkLimits(store: Store, l: Limits, operator: string | null, email: string | null): string | null {
    if (l.vouchersPerInstanceDay && store.countVouchers(ago(DAY)) >= l.vouchersPerInstanceDay) {
        return `Daily limit of ${l.vouchersPerInstanceDay} vouchers for this instance reached`;
    }
    if (l.vouchersPerUserHour && store.countVouchers(ago(HOUR), operator) >= l.vouchersPerUserHour) {
        return `Limit of ${l.vouchersPerUserHour} vouchers per hour reached, try again later`;
    }
    if (l.vouchersPerUserDay && store.countVouchers(ago(DAY), operator) >= l.vouchersPerUserDay) {
        return `Limit of ${l.vouchersPerUserDay} vouchers per day reached`;
    }
    if (email) {
        if (l.emailsPerUserHour && store.countEmails(ago(HOUR), { operator }) >= l.emailsPerUserHour) {
            return `Limit of ${l.emailsPerUserHour} voucher emails per hour reached, try again later`;
        }
        if (l.emailsPerRecipientDay && store.countEmails(ago(DAY), { recipient: email }) >= l.emailsPerRecipientDay) {
            return `This address already received ${l.emailsPerRecipientDay} vouchers today`;
        }
    }
    return null;
}
