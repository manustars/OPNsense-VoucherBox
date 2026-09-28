import React, { useEffect, useState } from 'react';

interface SyslogSettings {
  enabled: boolean;
  host: string;
  port: number;
  protocol: 'udp' | 'tcp' | 'tls';
  facility: number;
  appName: string;
  hostname: string;
  allowSelfSigned: boolean;
}

interface SettingsData {
  syslog: SyslogSettings;
  historyRetentionDays: number;
  historyRetentionDaysDefault: number;
}

const input = 'w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400';
const label = 'block text-sm font-medium text-gray-700 mb-1';

async function readError(res: Response) {
  return (await res.json().catch(() => null))?.error ?? res.statusText;
}

export default function Settings() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('api/settings')
      .then(async (res) => (res.ok ? res.json() : Promise.reject(new Error(await readError(res)))))
      .then(setData)
      .catch((e: Error) => setMessage({ ok: false, text: e.message }));
  }, []);

  if (!data) {
    return <div className="max-w-2xl mx-auto mt-8 p-6">{message?.text ?? 'Loading…'}</div>;
  }

  const s = data.syslog;
  const setSyslog = (patch: Partial<SyslogSettings>) => setData({ ...data, syslog: { ...s, ...patch } });

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syslog: s, historyRetentionDays: data.historyRetentionDays }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setData(await res.json());
      setMessage({ ok: true, text: 'Settings saved' });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('api/settings/syslog/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
      });
      if (!res.ok) throw new Error(await readError(res));
      setMessage({ ok: true, text: `Test message sent to ${s.host}:${s.port} (${s.protocol})` });
    } catch (e) {
      setMessage({ ok: false, text: `Syslog test failed: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto mt-8 p-6 rounded-xl shadow-lg bg-white space-y-8">
      <section className="space-y-4">
        <h2 className="text-2xl font-bold text-gray-800">Syslog</h2>
        <p className="text-sm text-gray-500">Each created voucher is sent as a JSON event (never the password).</p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.enabled} onChange={(e) => setSyslog({ enabled: e.target.checked })} />
          <span className="text-gray-700">Send events to syslog</span>
        </label>
        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2">
            <label className={label}>Host</label>
            <input className={input} value={s.host} placeholder="10.0.1.75" onChange={(e) => setSyslog({ host: e.target.value })} />
          </div>
          <div>
            <label className={label}>Port</label>
            <input type="number" className={input} value={s.port} onChange={(e) => setSyslog({ port: Number(e.target.value) })} />
          </div>
          <div>
            <label className={label}>Protocol</label>
            <select className={input} value={s.protocol} onChange={(e) => setSyslog({ protocol: e.target.value as SyslogSettings['protocol'] })}>
              <option value="udp">UDP</option>
              <option value="tcp">TCP</option>
              <option value="tls">TLS</option>
            </select>
          </div>
          <div>
            <label className={label}>Facility</label>
            <input type="number" min={0} max={23} className={input} value={s.facility} onChange={(e) => setSyslog({ facility: Number(e.target.value) })} />
          </div>
          <div>
            <label className={label}>App name</label>
            <input className={input} value={s.appName} onChange={(e) => setSyslog({ appName: e.target.value })} />
          </div>
          <div className="col-span-3">
            <label className={label}>Hostname in messages (empty = pod name)</label>
            <input className={input} value={s.hostname} placeholder="voucherbox-vlan20" onChange={(e) => setSyslog({ hostname: e.target.value })} />
          </div>
        </div>
        {s.protocol === 'tls' && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.allowSelfSigned} onChange={(e) => setSyslog({ allowSelfSigned: e.target.checked })} />
            <span className="text-gray-700">Allow self-signed certificate</span>
          </label>
        )}
        <button disabled={busy || !s.host} onClick={test} className="px-4 py-2 rounded-lg border border-gray-300 hover:bg-gray-100 disabled:opacity-50">
          Send test message
        </button>
      </section>

      <section className="space-y-2">
        <h2 className="text-2xl font-bold text-gray-800">History</h2>
        <label className={label}>Retention (days, 0 = keep forever)</label>
        <input
          type="number"
          min={0}
          className={input}
          value={data.historyRetentionDays}
          onChange={(e) => setData({ ...data, historyRetentionDays: Number(e.target.value) })}
        />
        <p className="text-sm text-gray-500">
          Older entries are deleted automatically. Default for this instance: {data.historyRetentionDaysDefault} days.
        </p>
      </section>

      <div className="flex items-center gap-4">
        <button disabled={busy} onClick={save} className="px-6 py-2 rounded-lg bg-blue-500 text-white font-semibold hover:bg-blue-600 disabled:opacity-50">
          Save
        </button>
        {message && <span className={message.ok ? 'text-green-600' : 'text-red-600'}>{message.text}</span>}
      </div>
    </div>
  );
}
