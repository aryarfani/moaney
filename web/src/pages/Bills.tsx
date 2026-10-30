import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api';
import { planApi, type Bill } from '../api-plan';
import { AmountInput, Sheet, toInputAmount, toMinor } from '../components';
import { useStore } from '../store';
import { BackHeader } from './Settings';
import './plan.css';
import './desk-settings.css';

const jakartaToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const daysUntil = (d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${jakartaToday()}T00:00:00Z`)) / 86400_000);

function dueLabel(d: string): { text: string; soon: boolean } {
  const n = daysUntil(d);
  if (n < 0) return { text: `${-n} ${-n === 1 ? 'day' : 'days'} overdue`, soon: true };
  if (n === 0) return { text: 'today', soon: true };
  if (n <= 7) return { text: `in ${n} ${n === 1 ? 'day' : 'days'}`, soon: true };
  return { text: new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }), soon: false };
}

interface Draft { id: number | null; name: string; amount: string; walletId: number; categoryId: number; nextDue: string }

function BillSheet({ draft, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: () => void }) {
  const { wallets, categories } = useStore();
  const [v, setV] = useState(draft);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const real = wallets.filter((w) => !w.archived && w.countsTowardTotal);
  const cats = categories.filter((c) => !c.archived && c.kind === 'expense');
  const amount = toMinor(v.amount);
  const ok = v.name.trim() && amount !== null && amount > 0 && v.walletId && v.categoryId && v.nextDue;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try { await fn(); onSaved(); onClose(); } catch (e) { setError(e instanceof ApiError ? e.message : 'Something went wrong.'); setBusy(false); }
  }

  return (
    <Sheet title={v.id === null ? 'Add a bill' : 'Edit bill'} onClose={onClose}>
      <form className="stack" onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        const body = { name: v.name, amount, walletId: v.walletId, categoryId: v.categoryId, nextDue: v.nextDue };
        void run(() => (v.id === null ? planApi.createBill(body) : planApi.patchBill(v.id, body)));
      }}>
        {error && <div className="err" role="alert">{error}</div>}
        <div className="field"><label htmlFor="bn">Name</label><input id="bn" className="input" value={v.name} maxLength={60} onChange={(e) => setV({ ...v, name: e.target.value })} autoFocus /></div>
        <div className="field"><label htmlFor="ba">Amount (Rp)</label><AmountInput id="ba" className="input" value={v.amount} onChange={(x) => setV({ ...v, amount: x })} placeholder="350.000" /></div>
        <div className="field"><label htmlFor="bw">Paid from</label>
          <select id="bw" className="input" value={v.walletId} onChange={(e) => setV({ ...v, walletId: Number(e.target.value) })}>{real.map((w) => <option key={w.id} value={w.id}>{w.emoji} {w.name}</option>)}</select>
        </div>
        <div className="field"><label htmlFor="bc">Category</label>
          <select id="bc" className="input" value={v.categoryId} onChange={(e) => setV({ ...v, categoryId: Number(e.target.value) })}>{cats.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}</select>
        </div>
        <div className="field"><label htmlFor="bd">Next due</label><input id="bd" className="input" type="date" value={v.nextDue} onChange={(e) => setV({ ...v, nextDue: e.target.value })} /></div>
        <div className="muted small">Repeats monthly on the same day.</div>
        <button className="btn block" disabled={!ok || busy}>{v.id === null ? 'Add bill' : 'Save changes'}</button>
        {v.id !== null && <button type="button" className="btn danger" disabled={busy} onClick={() => { if (confirm('Stop tracking this bill?')) void run(() => planApi.patchBill(v.id!, { active: false })); }}>Remove bill</button>}
      </form>
    </Sheet>
  );
}

export function BillsPage() {
  const { wallets, categories, wallet, money, reload } = useStore();
  const [bills, setBills] = useState<Bill[]>([]);
  const [auto, setAuto] = useState(true);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, v] = await Promise.all([planApi.bills(), planApi.values()]);
      setBills(b);
      setAuto(v['bills.autoMatch'] !== 'false');
    } catch {
      setError('Could not load bills. Check your connection.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function pay(b: Bill) {
    if (!confirm(`Record ${money(b.amount)} for ${b.name} as paid today?`)) return;
    setBusyId(b.id);
    setError('');
    try {
      const r = await planApi.payBill(b.id);
      setNotice(`${b.name} marked paid. Next due ${r.bill.nextDue}.`);
      await Promise.all([load(), reload()]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not record the payment.');
    } finally {
      setBusyId(null);
    }
  }

  async function toggleAuto() {
    const next = !auto;
    setAuto(next);
    try { await planApi.setValue('bills.autoMatch', String(next)); } catch { setAuto(!next); setError('Could not save that setting.'); }
  }

  const firstWallet = wallets.find((w) => !w.archived && w.countsTowardTotal)?.id ?? 0;
  const firstCategory = categories.find((c) => !c.archived && c.kind === 'expense')?.id ?? 0;
  const edit = (b: Bill): Draft => ({ id: b.id, name: b.name, amount: toInputAmount(b.amount), walletId: b.walletId, categoryId: b.categoryId, nextDue: b.nextDue });

  return (
    <>
      <BackHeader to="/settings" title="Recurring bills" />
      {error && <div className="notice" role="alert">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      <h2>Coming up</h2>
      {bills.length === 0 ? (
        <div className="card muted" style={{ textAlign: 'center' }}>No bills yet. Add rent, electricity or a loan so they are not forgotten.</div>
      ) : (
        <div className="card flush">
          {bills.map((b) => {
            const due = dueLabel(b.nextDue);
            return (
              <div key={b.id} className="item plain bill-row" style={{ minHeight: 72 }}>
                <button className="grow" style={{ background: 'none', border: 0, textAlign: 'left', padding: 0, cursor: 'pointer' }} onClick={() => setEditing(edit(b))} aria-label={`Edit ${b.name}`}>
                  <b style={{ fontSize: 15 }}>{b.name}</b>
                  <div className="sub">Monthly · {wallet(b.walletId)?.name ?? ''}</div>
                </button>
                <div className="bill-amt" style={{ textAlign: 'right' }}>
                  <div className="num" style={{ fontWeight: 800, fontSize: 14 }}>{money(b.amount)}</div>
                  <span className={`tag ${due.soon ? 'warn' : ''}`}>{due.text}</span>
                </div>
                <button className="btn outline small" style={{ minHeight: 44, padding: '0 12px' }} disabled={busyId === b.id} onClick={() => void pay(b)}>Paid</button>
              </div>
            );
          })}
        </div>
      )}

      <div className="card row between">
        <div>
          <b style={{ fontSize: 14 }}>Match payments automatically</b>
          <div className="sub" style={{ lineHeight: 1.4, maxWidth: 240 }}>When a notification fits a bill, mark it paid instead of adding a new expense.</div>
        </div>
        <button className="sw" role="switch" aria-checked={auto} aria-label="Match payments automatically" onClick={() => void toggleAuto()} />
      </div>

      <button className="btn" onClick={() => setEditing({ id: null, name: '', amount: '', walletId: firstWallet, categoryId: firstCategory, nextDue: jakartaToday() })}>Add a bill</button>
      {editing && <BillSheet draft={editing} onClose={() => setEditing(null)} onSaved={() => void load()} />}
    </>
  );
}
