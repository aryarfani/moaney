import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { capture } from './api-capture';
import { api, setCsrf } from './api';
import { StoreProvider } from './store';
import { AddPage } from './pages/Add';
import { ReportsPage } from './pages/Reports';
import { AskPage } from './pages/Ask';
import { WalletDetailPage } from './pages/WalletDetail';
import { SettingsPage } from './pages/Settings';
import { CategoriesPage } from './pages/Categories';
import { GoalsPage } from './pages/Goals';
import { BillsPage } from './pages/Bills';
import { DataPage } from './pages/Data';
import { SourcesPage } from './pages/Sources';
import { ReviewPage } from './pages/Review';
import { RulesPage } from './pages/Rules';
import { InvestmentsPage } from './pages/Investments';
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

const SETTINGS_LINKS = [
  ['/settings', 'Overview'], ['/settings/sources', 'Notification sources'], ['/settings/rules', 'Rules'], ['/settings/categories', 'Categories and budgets'],
  ['/settings/goals', 'Goals'], ['/settings/bills', 'Recurring bills'], ['/settings/data', 'Data and security'],
] as const;

/** On desktop the settings screens share a second column listing the sections; on phones it is hidden. */
function SettingsLayout() {
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        {SETTINGS_LINKS.map(([to, label]) => <NavLink key={to} to={to} end>{label}</NavLink>)}
      </nav>
      <div className="settings-body"><Outlet /></div>
    </div>
  );
}

function Shell({ onSignedOut }: { onSignedOut: () => void }) {
  const [pending, setPending] = useState(0);
  const loc = useLocation();
  useEffect(() => {
    capture.pendingCount().then((r) => setPending(r.count)).catch(() => undefined);
  }, [loc.pathname]);
  return (
    <StoreProvider onSignedOut={onSignedOut}>
      <main className="screen">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/wallets" element={<WalletsPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/ask" element={<AskPage />} />
          <Route path="/wallets/:id" element={<WalletDetailPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/investments" element={<InvestmentsPage />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<SettingsPage />} />
            <Route path="categories" element={<CategoriesPage />} />
            <Route path="goals" element={<GoalsPage />} />
            <Route path="bills" element={<BillsPage />} />
            <Route path="data" element={<DataPage />} />
            <Route path="sources" element={<SourcesPage />} />
            <Route path="rules" element={<RulesPage />} />
          </Route>
          <Route path="/add" element={<AddPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <nav className="nav" aria-label="Main">
        <div className="brand" aria-hidden="true"><span>M</span>Moaney</div>
        <NavLink to="/" end><Icon d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />Home</NavLink>
        <NavLink to="/history"><Icon d="M4 6h16M4 12h16M4 18h10" />History</NavLink>
        <NavLink to="/reports"><Icon d="M5 20V10M12 20V4M19 20v-7" />Reports</NavLink>
        <NavLink to="/wallets"><Icon d="M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zM16 14.5h.01" />Wallets</NavLink>
        <NavLink to="/add"><Icon d="M12 5v14M5 12h14" />Add</NavLink>
        <div className="nav-extra">
          <NavLink to="/review"><Icon d="M5 13l4 4L19 7" />Review{pending > 0 && <b className="nav-badge">{pending}</b>}</NavLink>
          <NavLink to="/ask"><Icon d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />Ask Moaney</NavLink>
          <NavLink to="/investments"><Icon d="M3 17l6-6 4 4 8-8M15 7h6v6" />Investments</NavLink>
          <NavLink to="/settings"><Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" />Settings</NavLink>
        </div>
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
