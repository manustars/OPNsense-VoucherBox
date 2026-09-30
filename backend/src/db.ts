import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { logger } from './expressUtils';

// Voucher history and admin settings. Voucher passwords are never stored.

export interface HistoryEntry {
    id: number;
    createdAt: string;      // ISO timestamp
    username: string;
    vouchergroup: string;
    provider: string;
    validityHours: number;
    expiresAt: string | null;
    email: string | null;
    emailSent: boolean;
    emailError: string | null;
    operator: string | null;
    // null = no terms configured when the voucher was created
    termsAccepted: boolean | null;
    termsVersion: string | null;
}

export type NewHistoryEntry = Omit<HistoryEntry, 'id' | 'createdAt'>;

export interface HistoryQuery {
    q?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
}

interface HistoryRow {
    id: number;
    created_at: string;
    username: string;
    vouchergroup: string;
    provider: string;
    validity_hours: number;
    expires_at: string | null;
    email: string | null;
    email_sent: number;
    email_error: string | null;
    operator: string | null;
    terms_accepted: number | null;
    terms_version: string | null;
}

function toEntry(r: HistoryRow): HistoryEntry {
    return {
        id: r.id,
        createdAt: r.created_at,
        username: r.username,
        vouchergroup: r.vouchergroup,
        provider: r.provider,
        validityHours: r.validity_hours,
        expiresAt: r.expires_at,
        email: r.email,
        emailSent: r.email_sent === 1,
        emailError: r.email_error,
        operator: r.operator,
        termsAccepted: r.terms_accepted === null ? null : r.terms_accepted === 1,
        termsVersion: r.terms_version,
    };
}

export type UserRole = 'user' | 'admin';

export interface SessionRow {
    id_hash: string;
    user_json: string;
    local_id: number | null;
    created_at: string;
    last_seen_at: string;
    expires_at: string;
    ip: string | null;
    user_agent: string | null;
}

export interface LocalUser {
    id: number;
    username: string;
    role: UserRole;
    disabled: boolean;
    failedAttempts: number;
    lockedUntil: string | null;
    lastLoginAt: string | null;
    createdAt: string;
}

interface UserRow {
    id: number;
    username: string;
    password_hash: string;
    role: UserRole;
    disabled: number;
    failed_attempts: number;
    locked_until: string | null;
    last_login_at: string | null;
    created_at: string;
}

// The password hash is never part of LocalUser: it is read only by getPasswordHash
function toUser(r: UserRow): LocalUser {
    return {
        id: r.id,
        username: r.username,
        role: r.role,
        disabled: r.disabled === 1,
        failedAttempts: r.failed_attempts,
        lockedUntil: r.locked_until,
        lastLoginAt: r.last_login_at,
        createdAt: r.created_at,
    };
}

export class Store {
    private db: DatabaseSync;

    constructor(dataDir: string) {
        fs.mkdirSync(dataDir, { recursive: true });
        const file = path.join(dataDir, 'voucherbox.db');
        this.db = new DatabaseSync(file);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS voucher_history (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at     TEXT    NOT NULL,
                username       TEXT    NOT NULL,
                vouchergroup   TEXT    NOT NULL,
                provider       TEXT    NOT NULL,
                validity_hours REAL    NOT NULL,
                expires_at     TEXT,
                email          TEXT,
                email_sent     INTEGER NOT NULL DEFAULT 0,
                email_error    TEXT,
                operator       TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_history_created ON voucher_history (created_at);
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS users (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                username        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
                password_hash   TEXT    NOT NULL,
                role            TEXT    NOT NULL CHECK (role IN ('user', 'admin')),
                disabled        INTEGER NOT NULL DEFAULT 0,
                failed_attempts INTEGER NOT NULL DEFAULT 0,
                locked_until    TEXT,
                last_login_at   TEXT,
                created_at      TEXT    NOT NULL,
                updated_at      TEXT    NOT NULL
            );
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                -- SHA-256 of the session id: the id itself lives only in the cookie
                id_hash      TEXT PRIMARY KEY,
                user_json    TEXT NOT NULL,
                local_id     INTEGER,
                created_at   TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                expires_at   TEXT NOT NULL,
                ip           TEXT,
                user_agent   TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_local ON sessions (local_id);
            CREATE TABLE IF NOT EXISTS terms_versions (
                version    TEXT PRIMARY KEY,
                text       TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
        `);
        // migrations for databases created by older versions
        const columns = (this.db.prepare('PRAGMA table_info(voucher_history)').all() as { name: string }[]).map((c) => c.name);
        if (!columns.includes('terms_accepted')) this.db.exec('ALTER TABLE voucher_history ADD COLUMN terms_accepted INTEGER');
        if (!columns.includes('terms_version')) this.db.exec('ALTER TABLE voucher_history ADD COLUMN terms_version TEXT');
        logger.info(`History database: ${file}`);
    }

    addHistory(e: NewHistoryEntry): HistoryEntry {
        const createdAt = new Date().toISOString();
        const res = this.db.prepare(`
            INSERT INTO voucher_history
                (created_at, username, vouchergroup, provider, validity_hours, expires_at, email, email_sent, email_error, operator, terms_accepted, terms_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(createdAt, e.username, e.vouchergroup, e.provider, e.validityHours, e.expiresAt,
            e.email, e.emailSent ? 1 : 0, e.emailError, e.operator,
            e.termsAccepted === null ? null : e.termsAccepted ? 1 : 0, e.termsVersion);
        return { ...e, id: Number(res.lastInsertRowid), createdAt };
    }

    queryHistory(query: HistoryQuery): { total: number; items: HistoryEntry[] } {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (query.q) {
            where.push('(username LIKE ? OR email LIKE ? OR operator LIKE ? OR vouchergroup LIKE ?)');
            const like = `%${query.q}%`;
            params.push(like, like, like, like);
        }
        if (query.from) {
            where.push('created_at >= ?');
            params.push(query.from);
        }
        if (query.to) {
            where.push('created_at <= ?');
            params.push(query.to);
        }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM voucher_history ${clause}`).get(...params) as { c: number }).c;
        const limit = Math.min(Math.max(query.limit ?? 100, 1), 10000);
        const offset = Math.max(query.offset ?? 0, 0);
        const rows = this.db.prepare(`SELECT * FROM voucher_history ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
            .all(...params, limit, offset) as unknown as HistoryRow[];
        return { total, items: rows.map(toEntry) };
    }

    // Deletes entries older than retentionDays (0 = keep forever). Returns the number of deleted rows.
    purgeHistory(retentionDays: number): number {
        if (!retentionDays || retentionDays <= 0) return 0;
        const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
        const res = this.db.prepare('DELETE FROM voucher_history WHERE created_at < ?').run(cutoff);
        return Number(res.changes);
    }

    // --- server-side sessions ---

    createSession(idHash: string, userJson: string, localId: number | null, expiresAt: string, ip: string | null, userAgent: string | null): void {
        const now = new Date().toISOString();
        this.db.prepare('INSERT INTO sessions (id_hash, user_json, local_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(idHash, userJson, localId, now, now, expiresAt, ip, userAgent);
    }

    getSession(idHash: string): SessionRow | undefined {
        return this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as SessionRow | undefined;
    }

    touchSession(idHash: string): void {
        this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(new Date().toISOString(), idHash);
    }

    deleteSession(idHash: string): void {
        this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
    }

    // Revokes every session of a local user, optionally keeping one (the caller's). Returns the number revoked.
    deleteUserSessions(localId: number, exceptIdHash?: string): number {
        const res = exceptIdHash
            ? this.db.prepare('DELETE FROM sessions WHERE local_id = ? AND id_hash <> ?').run(localId, exceptIdHash)
            : this.db.prepare('DELETE FROM sessions WHERE local_id = ?').run(localId);
        return Number(res.changes);
    }

    countUserSessions(localId: number): number {
        return (this.db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE local_id = ?').get(localId) as { c: number }).c;
    }

    purgeSessions(idleCutoff: string): number {
        const res = this.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?').run(new Date().toISOString(), idleCutoff);
        return Number(res.changes);
    }

    // --- counters for rate limits (from the history, so they survive restarts) ---

    countVouchers(sinceIso: string, operator?: string | null): number {
        if (operator === undefined) {
            return (this.db.prepare('SELECT COUNT(*) AS c FROM voucher_history WHERE created_at >= ?').get(sinceIso) as { c: number }).c;
        }
        return (this.db.prepare('SELECT COUNT(*) AS c FROM voucher_history WHERE created_at >= ? AND operator IS ?').get(sinceIso, operator) as { c: number }).c;
    }

    countEmails(sinceIso: string, filter: { operator?: string | null; recipient?: string }): number {
        if (filter.recipient !== undefined) {
            return (this.db.prepare('SELECT COUNT(*) AS c FROM voucher_history WHERE created_at >= ? AND email = ? COLLATE NOCASE').get(sinceIso, filter.recipient) as { c: number }).c;
        }
        return (this.db.prepare('SELECT COUNT(*) AS c FROM voucher_history WHERE created_at >= ? AND email IS NOT NULL AND operator IS ?').get(sinceIso, filter.operator ?? null) as { c: number }).c;
    }

    // --- terms and conditions versions (the exact text shown/sent stays available) ---

    saveTermsVersion(version: string, text: string): void {
        this.db.prepare('INSERT OR IGNORE INTO terms_versions (version, text, created_at) VALUES (?, ?, ?)')
            .run(version, text, new Date().toISOString());
    }

    getTermsVersion(version: string): { version: string; text: string; createdAt: string } | undefined {
        const r = this.db.prepare('SELECT version, text, created_at FROM terms_versions WHERE version = ?').get(version) as
            { version: string; text: string; created_at: string } | undefined;
        return r && { version: r.version, text: r.text, createdAt: r.created_at };
    }

    // --- local users ---

    getUserById(id: number): LocalUser | undefined {
        const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
        return r && toUser(r);
    }

    getUserByUsername(username: string): LocalUser | undefined {
        const r = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
        return r && toUser(r);
    }

    listUsers(): LocalUser[] {
        return (this.db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all() as unknown as UserRow[]).map(toUser);
    }

    countUsers(): number {
        return (this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
    }

    countActiveAdmins(): number {
        return (this.db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0").get() as { c: number }).c;
    }

    createUser(username: string, passwordHash: string, role: UserRole): LocalUser {
        const now = new Date().toISOString();
        const res = this.db.prepare('INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run(username, passwordHash, role, now, now);
        return this.getUserById(Number(res.lastInsertRowid))!;
    }

    updateUser(id: number, patch: { role?: UserRole; disabled?: boolean; passwordHash?: string }): void {
        const now = new Date().toISOString();
        if (patch.role !== undefined) this.db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(patch.role, now, id);
        if (patch.disabled !== undefined) this.db.prepare('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?').run(patch.disabled ? 1 : 0, now, id);
        if (patch.passwordHash !== undefined) {
            // a new password also clears the lockout
            this.db.prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
                .run(patch.passwordHash, now, id);
        }
    }

    deleteUser(id: number): void {
        this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }

    recordLoginFailure(id: number, maxAttempts: number, lockMinutes: number): void {
        const u = this.getUserById(id);
        if (!u) return;
        const attempts = u.failedAttempts + 1;
        const lockedUntil = attempts >= maxAttempts ? new Date(Date.now() + lockMinutes * 60000).toISOString() : null;
        this.db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
            .run(lockedUntil ? 0 : attempts, lockedUntil, id);
    }

    recordLoginSuccess(id: number): void {
        this.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
            .run(new Date().toISOString(), id);
    }

    getPasswordHash(id: number): string | undefined {
        return (this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as { password_hash: string } | undefined)?.password_hash;
    }

    getSetting<T>(key: string, fallback: T): T {
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
        if (!row) return fallback;
        try {
            return JSON.parse(row.value) as T;
        } catch {
            return fallback;
        }
    }

    setSetting(key: string, value: unknown): void {
        this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, JSON.stringify(value));
    }
}
