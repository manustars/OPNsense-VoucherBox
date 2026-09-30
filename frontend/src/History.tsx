import React, { useCallback, useEffect, useState } from 'react';

interface HistoryEntry {
  id: number;
  createdAt: string;
  username: string;
  vouchergroup: string;
  provider: string;
  validityHours: number;
  expiresAt: string | null;
  email: string | null;
  emailSent: boolean;
  emailError: string | null;
  operator: string | null;
  termsAccepted: boolean | null;
  termsVersion: string | null;
}

const PAGE_SIZE = 50;

function fmt(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

async function showTerms(version: string) {
  const res = await fetch(`api/terms/${encodeURIComponent(version)}`);
  const t = res.ok ? await res.json() : null;
  window.alert(t ? `Terms version ${t.version} (${new Date(t.createdAt).toLocaleString()})

${t.text}` : 'Terms version not found');
}

export default function History() {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ total: number; items: HistoryEntry[] }>({ total: 0, items: [] });
  const [error, setError] = useState<string | null>(null);

  const params = useCallback(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (from) p.set('from', new Date(from).toISOString());
    if (to) p.set('to', new Date(to).toISOString());
    return p;
  }, [q, from, to]);

  useEffect(() => {
    const p = params();
    p.set('limit', String(PAGE_SIZE));
    p.set('offset', String(page * PAGE_SIZE));
    fetch(`api/history?${p}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
        return res.json();
      })
      .then((d) => { setData(d); setError(null); })
      .catch((e: Error) => setError(e.message));
  }, [params, page]);

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const input = 'px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400';

  return (
    <div className="max-w-5xl mx-auto mt-8 p-6 rounded-xl shadow-lg bg-white">
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <h2 className="text-2xl font-bold text-gray-800 mr-auto">Voucher history</h2>
        <input className={input} placeholder="Search user, email, operator" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        <label className="text-sm text-gray-600">From <input type="datetime-local" className={input} value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} /></label>
        <label className="text-sm text-gray-600">To <input type="datetime-local" className={input} value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} /></label>
        <a href={`api/history.csv?${params()}`} className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600">Export CSV</a>
      </div>
      {error && <div className="text-red-600 mb-3">{error}</div>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="py-2 pr-3">Created</th>
              <th className="py-2 pr-3">Username</th>
              <th className="py-2 pr-3">Validity</th>
              <th className="py-2 pr-3">Expires</th>
              <th className="py-2 pr-3">Email</th>
              <th className="py-2 pr-3">Sent</th>
              <th className="py-2 pr-3">Operator</th>
              <th className="py-2 pr-3">Terms</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((e) => (
              <tr key={e.id} className="border-b last:border-0">
                <td className="py-2 pr-3 whitespace-nowrap">{fmt(e.createdAt)}</td>
                <td className="py-2 pr-3 font-mono">{e.username}</td>
                <td className="py-2 pr-3">{e.validityHours} h</td>
                <td className="py-2 pr-3 whitespace-nowrap">{fmt(e.expiresAt)}</td>
                <td className="py-2 pr-3">{e.email ?? '—'}</td>
                <td className="py-2 pr-3" title={e.emailError ?? undefined}>
                  {e.email ? (e.emailSent ? '✔' : <span className="text-amber-600">✘</span>) : '—'}
                </td>
                <td className="py-2 pr-3">{e.operator ?? '—'}</td>
                <td className="py-2 pr-3">
                  {e.termsVersion ? (
                    <button className="text-blue-600 hover:underline" title="Show the accepted text" onClick={() => showTerms(e.termsVersion!)}>
                      {e.termsAccepted ? '✔' : '✘'} {e.termsVersion.slice(0, 6)}
                    </button>
                  ) : '—'}
                </td>
              </tr>
            ))}
            {data.items.length === 0 && (
              <tr><td colSpan={8} className="py-6 text-center text-gray-400">No vouchers</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between mt-4 text-sm text-gray-600">
        <span>{data.total} vouchers</span>
        <div className="flex items-center gap-2">
          <button disabled={page === 0} onClick={() => setPage(page - 1)} className="px-3 py-1 rounded-lg border disabled:opacity-40">‹</button>
          <span>{page + 1} / {pages}</span>
          <button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} className="px-3 py-1 rounded-lg border disabled:opacity-40">›</button>
        </div>
      </div>
    </div>
  );
}
