import crypto from 'crypto';

// Encrypts secrets stored in the database (e.g. the SMTP password) with AES-256-GCM.
// The key comes from SETTINGS_ENCRYPTION_KEY, which must live outside the database (Kubernetes Secret).
// Format: "v1:<iv b64>:<tag b64>:<ciphertext b64>"

export class SecretBox {
    private key?: Buffer;

    constructor(rawKey: string | undefined) {
        if (!rawKey) return;
        if (rawKey.length < 32) throw new Error('SETTINGS_ENCRYPTION_KEY must be at least 32 characters');
        // any string is accepted; SHA-256 turns it into a 32-byte key
        this.key = crypto.createHash('sha256').update(rawKey, 'utf8').digest();
    }

    get available(): boolean {
        return !!this.key;
    }

    encrypt(plain: string): string {
        if (!this.key) throw new Error('SETTINGS_ENCRYPTION_KEY is not set: secrets cannot be stored');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
    }

    decrypt(stored: string): string {
        if (!this.key) throw new Error('SETTINGS_ENCRYPTION_KEY is not set: stored secrets cannot be read');
        const [version, iv, tag, data] = stored.split(':');
        if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Invalid encrypted value');
        try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
            decipher.setAuthTag(Buffer.from(tag, 'base64'));
            return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
        } catch {
            throw new Error('Cannot decrypt the stored secret: SETTINGS_ENCRYPTION_KEY has changed?');
        }
    }
}
