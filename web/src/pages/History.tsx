import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Txn } from '../api';
import { SearchSelect, TxnRow, TxnSheet } from '../components';
import { useStore } from '../store';
import './desk-main.css';

const PAGE = 100;

function dayLabel(d: string): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function HistoryPage() {
  const { wallets, categories, money } = useStore();
  const [rows, setRows] = useState<Txn[]>([]);
  const [more, setMore] = useState(false);
  const [q, setQ] = useState('');
  const [walletId, setWalletId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [type, setType] = useState('');
  const [open, setOpen] = useState<Txn | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');

  const query = useMemo(() => ({ q, wallet: walletId, category: categoryId, type }), [q, walletId, categoryId, type]);

  const load = useCallback(async (offset: number, replace: boolean) => {
    try {
      const data = await api.transactions({ ...query, limit: PAGE, offset });
      setRows((prev) => (replace ? data : [...prev, ...data]));
      setMore(data.length === PAGE);
      setError('');
    } catch {
      setError('Could not load history.');
    }
  }, [query]);

  useEffect(() => {
    const t = setTimeout(() => void load(0, true), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const days = useMemo(() => {
    const out: { date: string; items: Txn[]; spent: number }[] = [];
    for (const t of rows) {
      let g = out[out.length - 1];
      if (!g || g.date !== t.localDate) {
        g = { date: t.localDate, items: [], spent: 0 };
        out.push(g);
      }
      g.items.push(t);
      if (t.type === 'expense') g.spent += t.amount;
    }
    return out;
  }, [rows]);

  return (
    <>
      <h1>History</h1>
      <div className="hist-filters">
      <input className="input" type="search" placeholder="Search description" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="row">
        <SearchSelect ariaLabel="Wallet" allLabel="All wallets" value={walletId} onChange={setWalletId} options={wallets.map((w) => ({ value: String(w.id), label: w.name, emoji: w.emoji }))} />
        <SearchSelect ariaLabel="Category" allLabel="All categories" value={categoryId} onChange={setCategoryId} options={categories.filter((c) => !c.archived || String(c.id) === categoryId).map((c) => ({ value: String(c.id), label: c.name, emoji: c.emoji }))} />
      </div>
      <div className="seg" role="group" aria-label="Type">
        {[['', 'All'], ['expense', 'Out'], ['income', 'In'], ['transfer', 'Moves']].map(([v, label]) => (
          <button key={v} aria-pressed={type === v} onClick={() => setType(v!)}>{label}</button>
        ))}
      </div>
      </div>
      {error && <div className="notice" role="alert">{error}</div>}
      {days.length === 0 && !error && <div className="card muted" style={{ textAlign: 'center' }}>No entries match.</div>}
      {days.length > 0 && (
        <div className="txn-head with-act" aria-hidden="true"><span /><span>Description</span><span>Category</span><span>Wallet</span><span>Source</span><span>Amount</span><span>Actions</span></div>
      )}
      {days.map((d) => (
        <section key={d.date} aria-label={dayLabel(d.date)}>
          <div className="day"><span>{dayLabel(d.date)}</span><span className="num">{d.spent ? money(d.spent) : ''}</span></div>
          <div className="card flush txn-table" style={{ marginTop: 6 }}>{d.items.map((t) => <TxnRow key={t.id} t={t} onOpen={(x) => { setEditing(false); setOpen(x); }} onEdit={(x) => { setEditing(true); setOpen(x); }} />)}</div>
        </section>
      ))}
      {more && <button className="btn ghost" onClick={() => void load(rows.length, false)}>Load more</button>}
      {open && <TxnSheet key={`${open.id}${editing}`} txn={open} startEditing={editing} onClose={() => setOpen(null)} onChanged={() => void load(0, true)} />}
    </>
  );
}
