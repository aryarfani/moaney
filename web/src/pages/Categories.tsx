import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Category } from '../api';
import { planApi, type CategoryOverview } from '../api-plan';
import { AmountInput, Sheet, toInputAmount, toMinor } from '../components';
import { useStore } from '../store';
import { BackHeader } from './Settings';
import './plan.css';

const jakartaMonth = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);

interface Draft { id: number | null; name: string; emoji: string; kind: 'expense' | 'income'; budget: string }
const blank: Draft = { id: null, name: '', emoji: '📦', kind: 'expense', budget: '' };

function CategorySheet({ draft, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(draft);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const budget = v.budget.trim() ? toMinor(v.budget) : null;
  const budgetBad = v.budget.trim() !== '' && (budget === null || budget < 0);

  async function save(archive = false) {
    setBusy(true);
    setError('');
    try {
      if (v.id === null) await planApi.createCategory({ name: v.name, emoji: v.emoji || '📦', kind: v.kind, monthlyBudget: v.kind === 'expense' ? budget : null });
      else await planApi.patchCategory(v.id, { name: v.name, emoji: v.emoji || '📦', monthlyBudget: v.kind === 'expense' ? budget : null, ...(archive ? { archived: true } : {}) });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save.');
      setBusy(false);
    }
  }

  return (
    <Sheet title={v.id === null ? 'Add category' : 'Edit category'} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (v.name.trim() && !budgetBad) void save(); }}>
        {error && <div className="err" role="alert">{error}</div>}
        {v.id === null && (
          <div className="seg" role="group" aria-label="Type">
            {(['expense', 'income'] as const).map((k) => (
              <button type="button" key={k} aria-pressed={v.kind === k} onClick={() => setV({ ...v, kind: k })}>{k === 'expense' ? 'Expense' : 'Income'}</button>
            ))}
          </div>
        )}
        <div className="row">
          <div className="field" style={{ width: 84 }}><label htmlFor="ce">Emoji</label><input id="ce" className="input" value={v.emoji} maxLength={8} onChange={(e) => setV({ ...v, emoji: e.target.value })} /></div>
          <div className="field grow"><label htmlFor="cn">Name</label><input id="cn" className="input" value={v.name} maxLength={60} onChange={(e) => setV({ ...v, name: e.target.value })} autoFocus /></div>
        </div>
        {v.kind === 'expense' && (
          <div className="field">
            <label htmlFor="cb">Monthly budget (Rp, optional)</label>
            <AmountInput id="cb" className="input" value={v.budget} onChange={(x) => setV({ ...v, budget: x })} placeholder="No budget" />
            {budgetBad && <span className="err">Enter a number, e.g. 2.500.000</span>}
          </div>
        )}
        <button className="btn block" disabled={!v.name.trim() || budgetBad || busy}>{v.id === null ? 'Add category' : 'Save changes'}</button>
        {v.id !== null && (
          <button type="button" className="btn danger" disabled={busy} onClick={() => { if (confirm('Archive this category? Past entries keep it, but it is hidden from pickers.')) void save(true); }}>Archive category</button>
        )}
      </form>
    </Sheet>
  );
}

export function CategoriesPage() {
  const { categories, money, reload } = useStore();
  const [overview, setOverview] = useState<CategoryOverview[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const month = jakartaMonth();

  const load = useCallback(async () => {
    try {
      setOverview(await planApi.categoryOverview(month));
    } catch {
      setError('Could not load spending. Check your connection.');
    }
  }, [month]);
  useEffect(() => { void load(); }, [load]);

  const info = (id: number) => overview.find((o) => o.id === id);
  const active = categories.filter((c) => !c.archived);
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });

  function row(c: Category) {
    const o = info(c.id);
    const spent = o?.spent ?? 0;
    const budget = c.kind === 'expense' ? o?.budget ?? null : null;
    const pct = budget ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
    const tone = budget && spent > budget ? 'over' : budget && spent >= budget * 0.9 ? 'amber' : '';
    const draft: Draft = { id: c.id, name: c.name, emoji: c.emoji, kind: c.kind, budget: budget ? toInputAmount(budget) : '' };
    return (
      <button key={c.id} className="item" onClick={() => setEditing(draft)}>
        <span className="emoji" aria-hidden="true">{c.emoji}</span>
        <span className="grow">
          <span className="row between"><b>{c.name}</b><span className="amount">{money(spent)}</span></span>
          {budget ? (
            <>
              <div className={`bar ${tone}`} style={{ marginTop: 6 }} role="img" aria-label={`${pct} percent of budget`}><i style={{ width: `${pct}%` }} /></div>
              <div className="sub" style={{ marginTop: 3 }}>{spent > budget ? `${money(spent - budget)} over` : `${money(budget - spent)} left`} of {money(budget)}</div>
            </>
          ) : (
            <div className="sub">{c.kind === 'income' ? 'Income' : 'No budget'}</div>
          )}
        </span>
      </button>
    );
  }

  return (
    <>
      <BackHeader to="/settings" title="Categories" sub={`Spent in ${label} · budgets are optional`} />
      {error && <div className="notice" role="alert">{error}</div>}
      <h2>Expenses · {label}</h2>
      <div className="card flush">{active.filter((x) => x.kind === 'expense').map(row)}</div>
      <h2>Income · {label}</h2>
      <div className="card flush">{active.filter((x) => x.kind === 'income').map(row)}</div>
      <button className="btn" onClick={() => setEditing(blank)}>Add category</button>
      {editing && <CategorySheet draft={editing} onClose={() => setEditing(null)} onSaved={() => void Promise.all([reload(), load()])} />}
    </>
  );
}
