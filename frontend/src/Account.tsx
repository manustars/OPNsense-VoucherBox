import React, { useState } from 'react';

export default function Account({ name }: { name: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (next !== confirm) return setMessage({ ok: false, text: 'The new passwords do not match' });
    const res = await fetch('api/account/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    if (res.ok) {
      setCurrent(''); setNext(''); setConfirm('');
      setMessage({ ok: true, text: 'Password changed' });
    } else {
      setMessage({ ok: false, text: (await res.json().catch(() => null))?.error ?? res.statusText });
    }
  };

  const logoutOthers = async () => {
    const res = await fetch('api/account/logout-others', { method: 'POST' });
    const data = await res.json().catch(() => null);
    setMessage(res.ok ? { ok: true, text: `${data.revoked} other session(s) signed out` } : { ok: false, text: data?.error ?? res.statusText });
  };

  const input = 'w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400';
  return (
    <form onSubmit={submit} className="max-w-md mx-auto mt-8 p-8 rounded-xl shadow-lg bg-white space-y-4">
      <h2 className="text-2xl font-bold text-gray-800">Account: {name}</h2>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Current password</label>
        <input type="password" autoComplete="current-password" className={input} value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">New password (min. 10 characters)</label>
        <input type="password" autoComplete="new-password" className={input} value={next} onChange={(e) => setNext(e.target.value)} required />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Repeat new password</label>
        <input type="password" autoComplete="new-password" className={input} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </div>
      <button type="submit" className="w-full py-2 font-semibold rounded-lg bg-blue-500 text-white hover:bg-blue-600">Change password</button>
      <p className="text-xs text-gray-500">Changing the password signs out your other sessions.</p>
      <button type="button" onClick={logoutOthers} className="w-full py-2 rounded-lg border border-gray-300 hover:bg-gray-100">Sign out my other sessions</button>
      {message && <p className={message.ok ? 'text-green-600' : 'text-red-600'}>{message.text}</p>}
    </form>
  );
}
