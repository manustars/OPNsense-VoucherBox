import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import VoucherForm from './VoucherForm';
import History from './History';
import Settings from './Settings';
import './index.css';

type Tab = 'voucher' | 'history' | 'settings';

interface Me {
  oidcEnabled: boolean;
  user: { name: string; email?: string } | null;
  isAdmin: boolean;
}

function tabFromHash(): Tab {
  const h = window.location.hash.replace('#', '');
  return h === 'history' || h === 'settings' ? h : 'voucher';
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>(tabFromHash());

  useEffect(() => {
    fetch('api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then(setMe)
      .catch(() => setMe(null));
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const logout = async () => {
    const res = await fetch('auth/logout', { method: 'POST' });
    const data = res.ok ? await res.json() : null;
    window.location.href = data?.logoutUrl ?? './';
  };

  const isAdmin = me?.isAdmin ?? false;
  const current = !isAdmin && tab !== 'voucher' ? 'voucher' : tab;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'voucher', label: 'Voucher' },
    ...(isAdmin ? [{ id: 'history' as Tab, label: 'History' }, { id: 'settings' as Tab, label: 'Settings' }] : []),
  ];

  return (
    <div className="min-h-screen">
      <nav className="bg-white shadow-sm">
        <div className="max-w-5xl mx-auto px-4 flex items-center justify-between h-14">
          <div className="flex gap-1">
            {tabs.map((t) => (
              <a
                key={t.id}
                href={`#${t.id}`}
                className={`px-3 py-2 rounded-lg text-sm font-medium ${current === t.id ? 'bg-blue-500 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
              >
                {t.label}
              </a>
            ))}
          </div>
          {me?.oidcEnabled && me.user && (
            <div className="flex items-center gap-3 text-sm text-gray-600">
              <span title={me.user.email}>{me.user.name}</span>
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
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
