import React, { useEffect, useState } from 'react';

interface LocalUser {
  id: number;
  username: string;
  role: 'user' | 'admin';
  disabled: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

const input = 'px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400';

async function api(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
  return res.status === 204 ? null : res.json();
}

export default function Users() {
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({ username: '', password: '', role: 'user' as 'user' | 'admin' });

  const load = () => api('api/users', 'GET').then(setUsers).catch((e: Error) => setMessage({ ok: false, text: e.message }));
  useEffect(() => { load(); }, []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMessage(null);
    try {
      await fn();
      setMessage({ ok: true, text: ok });
      await load();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api('api/users', 'POST', form);
      setForm({ username: '', password: '', role: 'user' });
    }, `User ${form.username} created`);
  };

  const resetPassword = (u: LocalUser) => {
    const password = window.prompt(`New password for ${u.username} (at least 10 characters)`);
    if (password) run(() => api(`api/users/${u.id}`, 'PATCH', { password }), `Password of ${u.username} changed`);
  };

  const remove = (u: LocalUser) => {
    if (window.confirm(`Delete user ${u.username}?`)) run(() => api(`api/users/${u.id}`, 'DELETE'), `User ${u.username} deleted`);
  };

  const locked = (u: LocalUser) => !!u.lockedUntil && new Date(u.lockedUntil) > new Date();

  return (
    <div className="max-w-4xl mx-auto mt-8 p-6 rounded-xl shadow-lg bg-white space-y-6">
      <h2 className="text-2xl font-bold text-gray-800">Local users</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="py-2 pr-3">Username</th>
              <th className="py-2 pr-3">Role</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3">Last login</th>
              <th className="py-2 pr-3"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b last:border-0">
                <td className="py-2 pr-3 font-medium">{u.username}</td>
                <td className="py-2 pr-3">
                  <select
                    className="px-2 py-1 border border-gray-300 rounded"
                    value={u.role}
                    onChange={(e) => run(() => api(`api/users/${u.id}`, 'PATCH', { role: e.target.value }), `Role of ${u.username} updated`)}
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td className="py-2 pr-3">
                  {u.disabled ? <span className="text-gray-400">disabled</span> : locked(u) ? <span className="text-amber-600">locked</span> : 'active'}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
                <td className="py-2 pr-3 whitespace-nowrap text-right space-x-2">
                  <button className="px-2 py-1 rounded border hover:bg-gray-100" onClick={() => resetPassword(u)}>Set password</button>
                  <button
                    className="px-2 py-1 rounded border hover:bg-gray-100"
                    onClick={() => run(() => api(`api/users/${u.id}`, 'PATCH', { disabled: !u.disabled }), `User ${u.username} ${u.disabled ? 'enabled' : 'disabled'}`)}
                  >
                    {u.disabled ? 'Enable' : 'Disable'}
                  </button>
                  <button className="px-2 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50" onClick={() => remove(u)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={create} className="flex flex-wrap items-end gap-3 border-t pt-4">
        <div>
          <label className="block text-sm text-gray-600">Username</label>
          <input className={input} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
        </div>
        <div>
          <label className="block text-sm text-gray-600">Password (min. 10)</label>
          <input type="password" autoComplete="new-password" className={input} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        </div>
        <div>
          <label className="block text-sm text-gray-600">Role</label>
          <select className={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'user' | 'admin' })}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <button type="submit" className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600">Add user</button>
      </form>

      {message && <div className={message.ok ? 'text-green-600' : 'text-red-600'}>{message.text}</div>}
      <p className="text-sm text-gray-500">user: creates vouchers. admin: also history, settings and users.</p>
    </div>
  );
}
