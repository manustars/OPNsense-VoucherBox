import React, { useState } from 'react';
import { FaWifi } from 'react-icons/fa';

interface Props {
  modes: { local: boolean; oidc: boolean; oidcLabel?: string };
  onLoggedIn: () => void;
}

export default function Login({ modes, onLoggedIn }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
      setPassword('');
      onLoggedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const oidcLogin = `auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
  const input = 'w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400';

  return (
    <div className="max-w-sm mx-auto mt-16 p-8 rounded-xl shadow-lg bg-white">
      <div className="flex flex-col items-center mb-6">
        <FaWifi className="text-blue-500 text-4xl mb-2" />
        <h2 className="text-2xl font-bold text-gray-800">Voucher Box</h2>
      </div>
      {modes.local && (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
            <input className={input} value={username} autoComplete="username" autoFocus onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input type="password" className={input} value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <button type="submit" disabled={busy} className="w-full py-2 font-semibold rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}
      {modes.local && modes.oidc && <div className="my-4 text-center text-sm text-gray-400">or</div>}
      {modes.oidc && (
        <a href={oidcLogin} className="block w-full py-2 text-center font-semibold rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100">
          {modes.oidcLabel || 'Sign in with single sign-on'}
        </a>
      )}
    </div>
  );
}
