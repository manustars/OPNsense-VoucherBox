import dgram from 'dgram';
import net from 'net';
import os from 'os';
import tls from 'tls';

// Minimal RFC 5424 syslog sender (UDP, TCP or TLS). The message body is JSON,
// so receivers such as VictoriaLogs can index its fields.

export type SyslogProtocol = 'udp' | 'tcp' | 'tls';

export interface SyslogSettings {
    enabled: boolean;
    host: string;
    port: number;
    protocol: SyslogProtocol;
    // RFC 5424 facility number (16 = local0)
    facility: number;
    appName: string;
    // HOSTNAME field of the syslog message; empty = pod/host name
    hostname: string;
    // only for protocol "tls"
    allowSelfSigned: boolean;
}

export const defaultSyslogSettings: SyslogSettings = {
    enabled: false,
    host: '',
    port: 514,
    protocol: 'udp',
    facility: 16,
    appName: 'voucherbox',
    hostname: '',
    allowSelfSigned: false,
};

const TIMEOUT_MS = 5000;

// RFC 5424 PRINTUSASCII without spaces, max length
function field(value: string, max: number): string {
    const clean = value.replace(/[^\x21-\x7e]/g, '');
    return clean ? clean.slice(0, max) : '-';
}

export function validateSyslogSettings(s: SyslogSettings): string | null {
    if (!['udp', 'tcp', 'tls'].includes(s.protocol)) return 'protocol must be udp, tcp or tls';
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return 'port must be between 1 and 65535';
    if (!Number.isInteger(s.facility) || s.facility < 0 || s.facility > 23) return 'facility must be between 0 and 23';
    if (s.enabled && !s.host.trim()) return 'host is required when syslog is enabled';
    return null;
}

export function formatSyslogMessage(s: SyslogSettings, msgId: string, payload: Record<string, unknown>, severity = 6): string {
    const pri = s.facility * 8 + severity;
    const hostname = field(s.hostname || os.hostname(), 255);
    const appName = field(s.appName || 'voucherbox', 48);
    return `<${pri}>1 ${new Date().toISOString()} ${hostname} ${appName} ${process.pid} ${field(msgId, 32)} - ${JSON.stringify(payload)}`;
}

export function sendSyslog(s: SyslogSettings, msgId: string, payload: Record<string, unknown>, severity = 6): Promise<void> {
    const message = formatSyslogMessage(s, msgId, payload, severity);

    if (s.protocol === 'udp') {
        return new Promise((resolve, reject) => {
            const socket = dgram.createSocket(net.isIPv6(s.host) ? 'udp6' : 'udp4');
            const buf = Buffer.from(message);
            socket.send(buf, s.port, s.host, (err) => {
                socket.close();
                if (err) reject(err); else resolve();
            });
        });
    }

    // TCP/TLS: one connection per message, newline framing (RFC 6587 non-transparent)
    return new Promise((resolve, reject) => {
        const onConnect = () => socket.end(message + '\n');
        const socket: net.Socket = s.protocol === 'tls'
            ? tls.connect({ host: s.host, port: s.port, servername: net.isIP(s.host) ? undefined : s.host, rejectUnauthorized: !s.allowSelfSigned }, onConnect)
            : net.connect({ host: s.host, port: s.port }, onConnect);
        socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error(`syslog ${s.protocol} connection to ${s.host}:${s.port} timed out`)));
        socket.once('error', reject);
        socket.once('close', (hadError) => { if (!hadError) resolve(); });
    });
}
