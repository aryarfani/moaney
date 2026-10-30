import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Chip, type Summary, type Txn } from '../api';
import { TxnRow, TxnSheet } from '../components';
import { useStore } from '../store';

const jakartaToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

function compareSentence(s: Summary, money: (n: number) => string): string {
  const diff = s.month.total - s.sameDayLastMonth.total;
  if (s.sameDayLastMonth.total === 0) return 'No spending recorded for the same days last month.';
  if (diff === 0) return 'The same as this point last month.';
  return `${money(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than this point last month.`;
}

export function HomePage() {
  const { money, category, wallets, reload } = useStore();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [todays, setTodays] = useState<Txn[]>([]);
  const [chips, setChips] = useState<Chip[]>([]);
  const [open, setOpen] = useState<Txn | null>(null);
  const [error, setError] = useState('');
  const [logged, setLogged] = useState('');
  const date = jakartaToday();

  const load = useCallback(async () => {
    try {
      const [s, t, c] = await Promise.all([api.summary(date), api.transactions({ from: date, to: date, limit: 50 }), api.suggestions()]);
      setSummary(s);
      setTodays(t);
      setChips(c.logAgain);
    } catch {
      setError('Could not load. Check your connection.');
    }
  }, [date]);
  useEffect(() => { void load(); }, [load]);

  async function logAgain(c: Chip) {
    setError('');
    try {
      await api.createBulk([{ type: 'expense', amount: c.amount, walletId: c.walletId, categoryId: c.categoryId, description: c.description, source: 'manual' }]);
      setLogged(`${c.description} logged for today`);
      await Promise.all([load(), reload()]);
    } catch {
      setError('Could not save that entry.');
    }
  }

  const h = new Date().getHours();
  const hello = h < 11 ? 'Good morning' : h < 15 ? 'Good afternoon' : h < 19 ? 'Good evening' : 'Good night';
  const noRealWallet = wallets.length > 0 && summary && summary.month.count === 0 && todays.length === 0 && chips.length === 0;

  return (
    <>
      <header>
        <div className="muted small">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <h1>{hello}</h1>
      </header>
      {error && <div className="notice" role="alert">{error}</div>}
      {logged && <div className="notice" role="status">{logged}</div>}

      <section className="card" aria-label="Today">
        <div className="muted small">Spent today</div>
        <div className="big">{money(summary?.today.total ?? 0)}</div>
        <div className="muted small">{summary?.today.count ?? 0} {summary?.today.count === 1 ? "payment" : "payments"}</div>
      </section>

      {chips.length > 0 && (
        <section aria-label="Log again">
          <h2>Log again</h2>
          <div className="chips" style={{ marginTop: 8 }}>
            {chips.map((c) => (
              <button key={`${c.description}-${c.categoryId}`} className="chip" onClick={() => logAgain(c)}>
                <span aria-hidden="true">{category(c.categoryId)?.emoji}</span>{c.description} · {money(c.amount)}
              </button>
            ))}
          </div>
        </section>
      )}

      {summary && (
        <section className="card" aria-label="This month">
          <div className="muted small">This month so far</div>
          <div className="row between" style={{ marginTop: 4 }}>
            <div><div className="muted small">Money out</div><b className="num">{money(summary.month.total)}</b></div>
            <div style={{ textAlign: 'right' }}><div className="muted small">Money in</div><b className="num">{money(summary.month.income)}</b></div>
          </div>
          <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>{compareSentence(summary, money)}</div>
          {summary.topCategories.map((c) => (
            <div key={c.categoryId} className="row between small" style={{ marginTop: 8 }}>
              <span><span aria-hidden="true">{c.emoji}</span> {c.name}</span><b className="num">{money(c.total)}</b>
            </div>
          ))}
        </section>
      )}

      <h2>Today</h2>
      {todays.length === 0 ? (
        <div className="card muted" style={{ textAlign: 'center' }}>
          Nothing recorded today.
          {noRealWallet && <div style={{ marginTop: 10 }}><Link to="/import">Bring in your history</Link></div>}
        </div>
      ) : (
        <div className="card flush">{todays.map((t) => <TxnRow key={t.id} t={t} onOpen={setOpen} />)}</div>
      )}
      {open && <TxnSheet txn={open} onClose={() => setOpen(null)} onChanged={() => void load()} />}
    </>
  );
}
