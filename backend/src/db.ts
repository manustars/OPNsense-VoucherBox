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
    };
}

export type UserRole = 'user' | 'admin';

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
        logger.info(`History database: ${file}`);
    }

    addHistory(e: NewHistoryEntry): HistoryEntry {
        const createdAt = new Date().toISOString();
        const res = this.db.prepare(`
            INSERT INTO voucher_history
                (created_at, username, vouchergroup, provider, validity_hours, expires_at, email, email_sent, email_error, operator)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(createdAt, e.username, e.vouchergroup, e.provider, e.validityHours, e.expiresAt,
            e.email, e.emailSent ? 1 : 0, e.emailError, e.operator);
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
