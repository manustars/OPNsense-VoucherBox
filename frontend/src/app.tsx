import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import VoucherForm from './VoucherForm';
import History from './History';
import Settings from './Settings';
import Users from './Users';
import Account from './Account';
import Login from './Login';
import './index.css';

type Tab = 'voucher' | 'history' | 'settings' | 'users' | 'account';
const TABS: Tab[] = ['voucher', 'history', 'settings', 'users', 'account'];

interface Me {
  authEnabled: boolean;
  authModes: { local: boolean; oidc: boolean; oidcLabel?: string };
  authenticated: boolean;
  user: { name: string; email?: string; source: 'local' | 'oidc' } | null;
  isAdmin: boolean;
}

function tabFromHash(): Tab {
  const h = window.location.hash.replace('#', '') as Tab;
  return TABS.includes(h) ? h : 'voucher';
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(tabFromHash());

  const loadMe = useCallback(() => {
    fetch('api/me')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
      .then((m: Me) => { setMe(m); setError(null); })
      .catch((e: Error) => setError(e.message));
  }, []);

  // A 401 from the API means the session expired (idle timeout, logout elsewhere): show the login again
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const res = await original(...args);
      const url = String(args[0] instanceof Request ? args[0].url : args[0]);
      if (res.status === 401 && url.includes('api/') && !url.includes('api/me') && !url.includes('api/login')) loadMe();
      return res;
    };
    return () => { window.fetch = original; };
  }, [loadMe]);

  useEffect(() => {
    loadMe();
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [loadMe]);

  // Single sign-on only: go straight to the identity provider
  useEffect(() => {
    if (me && !me.authenticated && me.authModes.oidc && !me.authModes.local) {
      window.location.href = `auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
    }
  }, [me]);

  if (error) return <div className="max-w-md mx-auto mt-16 text-center text-red-600">{error}</div>;
  if (!me) return null;
  if (!me.authenticated) return <Login modes={me.authModes} onLoggedIn={loadMe} />;

  const logout = async () => {
    const res = await fetch('auth/logout', { method: 'POST' });
    const data = res.ok ? await res.json() : null;
    window.location.href = data?.logoutUrl ?? './';
  };

  const isLocal = me.user?.source === 'local';
  const allowed: Tab[] = [
    'voucher',
    ...(me.isAdmin ? (['history', 'settings'] as Tab[]) : []),
    ...(me.isAdmin && me.authModes.local ? (['users'] as Tab[]) : []),
    ...(isLocal ? (['account'] as Tab[]) : []),
  ];
  const current = allowed.includes(tab) ? tab : 'voucher';
  const labels: Record<Tab, string> = { voucher: 'Voucher', history: 'History', settings: 'Settings', users: 'Users', account: 'Account' };

  return (
    <div className="min-h-screen">
      <nav className="bg-white shadow-sm">
        <div className="max-w-5xl mx-auto px-4 flex items-center justify-between h-14">
          <div className="flex gap-1">
            {allowed.filter((t) => t !== 'account').map((t) => (
              <a
                key={t}
                href={`#${t}`}
                className={`px-3 py-2 rounded-lg text-sm font-medium ${current === t ? 'bg-blue-500 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
              >
                {labels[t]}
              </a>
            ))}
          </div>
          {me.authEnabled && me.user && (
            <div className="flex items-center gap-3 text-sm text-gray-600">
              {isLocal ? (
                <a href="#account" className="hover:underline" title="Change password">{me.user.name}</a>
              ) : (
                <span title={me.user.email}>{me.user.name}</span>
              )}
              <button onClick={logout} className="px-3 py-1 rounded-lg border border-gray-300 hover:bg-gray-100">
                Logout
              </button>
            </div>
          )}
        </div>
      </nav>
      {current === 'voucher' && <VoucherForm />}
      {current === 'history' && <History />}
      {current === 'settings' && <Settings />}
      {current === 'users' && <Users />}
      {current === 'account' && me.user && <Account name={me.user.name} />}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
