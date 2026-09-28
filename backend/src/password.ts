import crypto from 'crypto';

// scrypt password hashing: "scrypt$N$r$p$<salt b64>$<hash b64>"
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 10;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, keylen, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
    });
}

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, N, R, P, KEYLEN);
    return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, keyB64] = parts;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p), expected.length);
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Used when the username does not exist, so the response time does not reveal it
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
    dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
    return dummyHash;
}

export function validatePassword(password: unknown): string | null {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    if (password.length > 256) return 'Password is too long';
    return null;
}

export function validateUsername(username: unknown): string | null {
    if (typeof username !== 'string' || !/^[A-Za-z0-9._@-]{2,64}$/.test(username)) return 'Username must be 2-64 characters: letters, digits, . _ @ -';
    return null;
}
