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
