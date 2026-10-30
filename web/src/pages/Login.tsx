import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import './desk-invest.css';

export function LoginPage({ onDone }: { onDone: (csrf: string) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onDone((await api.login(password)).csrf);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
      setBusy(false);
    }
  }

  return (
    <main className="screen login-screen" style={{ justifyContent: 'center' }}>
      <div className="login-wrap">
      <aside className="login-brand" aria-hidden="true">
        <div className="login-mark"><span>M</span>Moaney</div>
        <div>
          <div className="login-tag">Your money, noted automatically.</div>
          <div className="login-sub">Payments from your wallets land here, ready for you to review.</div>
        </div>
        <div className="login-fine">Private, single-user app</div>
      </aside>
      <form className="card login-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <h1>Moaney</h1>
          <div className="muted">Sign in to continue.</div>
        </div>
        <div className="field">
          <label htmlFor="pw">Password</label>
          <input id="pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
        </div>
        {error && <div className="err" role="alert">{error}</div>}
        <button className="btn block" disabled={busy || !password}>Sign in</button>
      </form>
      </div>
    </main>
  );
}
