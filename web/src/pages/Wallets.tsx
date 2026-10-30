import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useStore } from '../store';
import { AmountInput } from '../components';
import './desk-money.css';

const KINDS = [['bank', 'Bank'], ['ewallet', 'E-wallet'], ['cash', 'Cash'], ['credit_card', 'Credit card'], ['receivable', 'Owed to me']] as const;

export function WalletsPage() {
  const { wallets, money, reload, signOut } = useStore();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<string>('bank');
  const [opening, setOpening] = useState('');
  const [error, setError] = useState('');

  const counted = wallets.filter((w) => w.countsTowardTotal && !w.archived);
  const total = counted.reduce((s, w) => s + w.balance, 0);
  const history = wallets.filter((w) => !w.countsTowardTotal);

  async function add() {
    setError('');
    const cleaned = opening.replace(/[.\s]/g, '').replace(',', '.');
    if (cleaned && !/^-?\d+(\.\d{1,2})?$/.test(cleaned)) { setError('Opening balance should be a number'); return; }
    const [w = '0', f = ''] = cleaned.replace('-', '').split('.');
    const minor = Number(w + f.padEnd(2, '0')) * (cleaned.startsWith('-') ? -1 : 1);
    try {
      await api.createWallet({ name, kind, openingBalance: minor });
      setName(''); setOpening(''); setAdding(false);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add wallet');
    }
  }

  return (
    <>
      <div className="row between">
        <h1 className="d-grow">Wallets</h1>
        <Link to="/settings" className="btn ghost" style={{ minHeight: 44 }} aria-label="Settings">⚙️ Settings</Link>
        <button className="btn d-only" onClick={() => setAdding(true)}>Add a wallet</button>
      </div>
      <div className="d-wtop">
        <section className="card" aria-label="Total balance">
          <div className="muted small">Total balance</div>
          <div className="big">{money(total)}</div>
          <div className="muted small">Counts real wallets only. “Before Moaney” is history and is left out.</div>
        </section>
        <div className="d-links d-only">
          <Link to="/settings/goals" className="card d-link"><b>Goals</b><span className="muted small">Set money aside without moving it</span></Link>
          <Link to="/investments" className="card d-link"><b>Investments</b><span className="muted small">Holdings, prices and gains</span></Link>
        </div>
      </div>

      <h2 className="d-only">Your wallets</h2>
      <div className="card flush d-wallets">
        {counted.map((w) => (
          <Link key={w.id} to={`/wallets/${w.id}`} className="item" style={{ textDecoration: 'none', color: 'inherit' }}>
            <span className="emoji" aria-hidden="true">{w.emoji}</span>
            <span className="grow"><b>{w.name}</b><div className="muted small">{KINDS.find(([k]) => k === w.kind)?.[1] ?? w.kind}</div></span>
            <span className="amount">{money(w.balance)}</span>
          </Link>
        ))}
      </div>

      {history.length > 0 && (
        <>
          <h2>History only</h2>
          <div className="card flush">
            {history.map((w) => (
              <div key={w.id} className="item" style={{ cursor: 'default' }}>
                <span className="emoji" aria-hidden="true">{w.emoji}</span>
                <span className="grow"><b>{w.name}</b><div className="muted small">Not part of balances or net worth</div></span>
              </div>
            ))}
          </div>
        </>
      )}

      {adding ? (
        <form className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <div className="field"><label htmlFor="wn">Name</label><input id="wn" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus /></div>
          <div className="field"><label htmlFor="wk">Type</label>
            <select id="wk" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </div>
          <div className="field"><label htmlFor="wo">Opening balance (Rp)</label><AmountInput id="wo" className="input" allowNegative value={opening} onChange={setOpening} placeholder="0" /></div>
          {error && <div className="err" role="alert">{error}</div>}
          <div className="row"><button className="btn grow" disabled={!name.trim()}>Add wallet</button><button type="button" className="btn ghost" onClick={() => setAdding(false)}>Cancel</button></div>
        </form>
      ) : (
        <button className="btn ghost m-only" onClick={() => setAdding(true)}>Add a wallet</button>
      )}

      <Link to="/investments" className="item card m-only" style={{ textDecoration: 'none', color: 'inherit', padding: '8px 16px' }}>
        <span className="emoji" aria-hidden="true">📈</span>
        <span className="grow"><b>Investments</b><div className="muted small">Holdings, prices and gains</div></span>
      </Link>

      <h2>Data</h2>
      <div className="card flush">
        <Link to="/import" className="item" style={{ textDecoration: 'none', color: 'inherit' }}><span className="grow"><b>Import transactions (CSV)</b><div className="muted small">Use the template to bring in old data</div></span></Link>
        <button className="item" onClick={() => void downloadExport()}><span className="grow"><b>Export transactions</b><div className="muted small">Download a CSV</div></span></button>
        <button className="item" onClick={() => void signOut()}><span className="grow"><b>Sign out</b></span></button>
      </div>
    </>
  );
}

async function downloadExport() {
  const text = await api.exportCsv();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = 'moaney-transactions.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}
