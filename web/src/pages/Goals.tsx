import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api';
import { planApi, type Goal } from '../api-plan';
import { AmountInput, Sheet, toInputAmount, toMinor } from '../components';
import { useStore } from '../store';
import { BackHeader } from './Settings';
import './plan.css';

const jakartaToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

/** Same maths as the server: minor units per month to reach the target by the due date. */
function monthlyNeeded(g: Goal): number | null {
  if (!g.dueDate || g.saved >= g.target) return null;
  const [y1, m1] = jakartaToday().split('-').map(Number) as [number, number];
  const [y2, m2] = g.dueDate.split('-').map(Number) as [number, number];
  return Math.ceil((g.target - g.saved) / Math.max(1, (y2 - y1) * 12 + (m2 - m1)));
}

interface Draft { id: number | null; name: string; target: string; saved: string; dueDate: string }

function GoalSheet({ draft, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(draft);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const target = toMinor(v.target);
  const saved = v.saved.trim() ? toMinor(v.saved) : 0;
  const ok = v.name.trim() && target !== null && target > 0 && saved !== null && saved >= 0;

  async function save(archive = false) {
    setBusy(true);
    setError('');
    try {
      const body = { name: v.name, target, saved, dueDate: v.dueDate || null, ...(archive ? { archived: true } : {}) };
      if (v.id === null) await planApi.createGoal(body);
      else await planApi.patchGoal(v.id, body);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save.');
      setBusy(false);
    }
  }

  return (
    <Sheet title={v.id === null ? 'New goal' : 'Edit goal'} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (ok) void save(); }}>
        {error && <div className="err" role="alert">{error}</div>}
        <div className="field"><label htmlFor="gn">Name</label><input id="gn" className="input" value={v.name} maxLength={60} onChange={(e) => setV({ ...v, name: e.target.value })} autoFocus /></div>
        <div className="field"><label htmlFor="gt">Target (Rp)</label><AmountInput id="gt" className="input" value={v.target} onChange={(x) => setV({ ...v, target: x })} placeholder="10.000.000" /></div>
        <div className="field"><label htmlFor="gs">Set aside so far (Rp)</label><AmountInput id="gs" className="input" value={v.saved} onChange={(x) => setV({ ...v, saved: x })} placeholder="0" /></div>
        <div className="field"><label htmlFor="gd">Target date (optional)</label><input id="gd" className="input" type="date" value={v.dueDate} onChange={(e) => setV({ ...v, dueDate: e.target.value })} /></div>
        <button className="btn block" disabled={!ok || busy}>{v.id === null ? 'Create goal' : 'Save changes'}</button>
        {v.id !== null && (
          <button type="button" className="btn danger" disabled={busy} onClick={() => { if (confirm('Remove this goal? No money moves; it only stops being tracked.')) void save(true); }}>Remove goal</button>
        )}
      </form>
    </Sheet>
  );
}

function AddMoneySheet({ goal, onClose, onSaved }: { goal: Goal; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const minor = toMinor(amount);
  return (
    <Sheet title={`Add to ${goal.name}`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        if (!minor || minor <= 0) return;
        try { await planApi.addToGoal(goal.id, minor); onSaved(); onClose(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not save.'); }
      }}>
        {error && <div className="err" role="alert">{error}</div>}
        <div className="field"><label htmlFor="ga">Amount (Rp)</label><AmountInput id="ga" className="input" value={amount} onChange={setAmount} placeholder="500.000" autoFocus /></div>
        <div className="muted small">This only updates the goal. It does not move money between wallets.</div>
        <button className="btn block" disabled={!minor || minor <= 0}>Add money</button>
      </form>
    </Sheet>
  );
}

export function GoalsPage() {
  const { money, compact } = useStore();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [adding, setAdding] = useState<Goal | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setGoals(await planApi.goals()); } catch { setError('Could not load goals. Check your connection.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const totalSaved = goals.reduce((s, g) => s + g.saved, 0);

  return (
    <>
      <BackHeader to="/settings" title="Goals" sub={`${compact(totalSaved)} set aside · still counts as your money`} />
      {error && <div className="notice" role="alert">{error}</div>}
      {goals.length === 0 && !error && <div className="card muted" style={{ textAlign: 'center' }}>No goals yet. Set one for something you are saving towards.</div>}
      {goals.map((g) => {
        const pct = Math.min(100, Math.floor((g.saved / g.target) * 100));
        const need = monthlyNeeded(g);
        return (
          <section key={g.id} className="card stack" aria-label={g.name}>
            <div className="row between"><b style={{ fontSize: 16 }}>{g.name}</b><b className="num" style={{ color: 'var(--accent-ink)' }}>{pct}%</b></div>
            <div className="bar thick" role="img" aria-label={`${pct} percent of the goal`}><i style={{ width: `${pct}%` }} /></div>
            <div className="row between" style={{ fontSize: 13 }}>
              <span className="num"><b>{money(g.saved)}</b> <span className="muted">of {money(g.target)}</span></span>
              {g.dueDate && <span className="muted">By {new Date(`${g.dueDate}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}</span>}
            </div>
            {need !== null && <div className="muted small">Save about {money(need)} a month to reach it on time.</div>}
            {g.saved >= g.target && <div className="tag good" style={{ alignSelf: 'flex-start' }}>Reached</div>}
            <div className="row">
              <button className="btn outline small" onClick={() => setAdding(g)}>Add money</button>
              <button className="btn outline small" onClick={() => setEditing({ id: g.id, name: g.name, target: toInputAmount(g.target), saved: g.saved ? toInputAmount(g.saved) : '', dueDate: g.dueDate ?? '' })}>Edit</button>
            </div>
          </section>
        );
      })}
      <button className="btn" onClick={() => setEditing({ id: null, name: '', target: '', saved: '', dueDate: '' })}>New goal</button>
      {editing && <GoalSheet draft={editing} onClose={() => setEditing(null)} onSaved={() => void load()} />}
      {adding && <AddMoneySheet goal={adding} onClose={() => setAdding(null)} onSaved={() => void load()} />}
    </>
  );
}
