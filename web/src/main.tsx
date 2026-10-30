import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, setCsrf } from './api';
import { StoreProvider } from './store';
import { AddPage } from './pages/Add';
import { HistoryPage } from './pages/History';
import { HomePage } from './pages/Home';
import { ImportPage } from './pages/Import';
import { LoginPage } from './pages/Login';
import { WalletsPage } from './pages/Wallets';
import './styles.css';

const Icon = ({ d }: { d: string }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

function Shell({ onSignedOut }: { onSignedOut: () => void }) {
  return (
    <StoreProvider onSignedOut={onSignedOut}>
      <main className="screen">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/wallets" element={<WalletsPage />} />
          <Route path="/add" element={<AddPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <nav className="nav" aria-label="Main">
        <NavLink to="/" end><Icon d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />Home</NavLink>
        <NavLink to="/history"><Icon d="M4 6h16M4 12h16M4 18h10" />History</NavLink>
        <NavLink to="/wallets"><Icon d="M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zM16 14.5h.01" />Wallets</NavLink>
        <NavLink to="/add"><Icon d="M12 5v14M5 12h14" />Add</NavLink>
      </nav>
    </StoreProvider>
  );
}

function App() {
  const [state, setState] = useState<'loading' | 'out' | 'in'>('loading');
  useEffect(() => {
    api.me().then((m) => { setCsrf(m.csrf); setState('in'); }).catch(() => setState('out'));
  }, []);
  const signedOut = useCallback(() => setState('out'), []);
  if (state === 'loading') return <div className="center muted">Loading…</div>;
  if (state === 'out') return <LoginPage onDone={(csrf) => { setCsrf(csrf); setState('in'); }} />;
  return <Shell onSignedOut={signedOut} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js');
}
