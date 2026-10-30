import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, type Proposal } from '../api';
import { TxnForm, toMinor } from '../components';
import { useStore } from '../store';
import './desk-main.css';

const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

export function AddPage() {
  const { wallets, categories, money, wallet, category, reload } = useStore();
  const nav = useNavigate();
  const [mode, setMode] = useState<'type' | 'form'>('type');
  const [text, setText] = useState('');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const real = wallets.filter((w) => w.kind !== 'history' && !w.archived);
  const defaultWallet = (real.find((w) => w.kind === 'cash') ?? real[0])?.id ?? 0;
  const bad = (p: Proposal) => p.amount === null || p.problems.length > 0 || !p.walletId || (p.type === 'transfer' ? !p.toWalletId : !p.categoryId);

  async function parse() {
    setBusy(true);
    setError('');
    try {
      setProposals(await api.parse(text));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not read that');
    }
    setBusy(false);
  }

  async function save(items: Proposal[]) {
    setBusy(true);
    setError('');
    try {
      await api.createBulk(items.map((p) => ({
        type: p.type, amount: p.amount, walletId: p.walletId, toWalletId: p.type === 'transfer' ? p.toWalletId : null,
        categoryId: p.type === 'transfer' ? null : p.categoryId, description: p.description, source: 'typed',
      })));
      await reload();
      nav('/');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save');
      setBusy(false);
    }
  }

  const patch = (i: number, p: Partial<Proposal>) => setProposals((all) => all.map((x, j) => (j === i ? { ...x, ...p, problems: [] } : x)));

  return (
    <>
      <h1>Add</h1>
      <div className="seg" role="group" aria-label="Entry mode">
        <button aria-pressed={mode === 'type'} onClick={() => setMode('type')}>Type it</button>
        <button aria-pressed={mode === 'form'} onClick={() => setMode('form')}>Form</button>
      </div>
      {error && <div className="err" role="alert">{error}</div>}

      {mode === 'type' ? (
        <div className="add-grid">
          <div className="add-main">
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label htmlFor="free" className="muted small" style={{ fontWeight: 700 }}>Type one or more payments</label>
            <textarea id="free" className="input" value={text} onChange={(e) => { setText(e.target.value); setProposals([]); }} placeholder="kopi 28k gopay dan parkir 3k" />
            <div className="muted small">Examples: nasbung 16k · nasbung 16k @2 (two entries) · nasbung 16k x2 (one entry, 32k) · gaji 8jt bca</div>
            <button className="btn" disabled={!text.trim() || busy} onClick={parse}>Read it</button>
          </div>

          {proposals.map((p, i) => (
            <div key={i} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="row between">
                <b>{p.description || p.raw}</b>
                <b className="num">{p.amount !== null ? money(p.amount) : '—'}</b>
              </div>
              {p.problems.map((m) => <div key={m} className="err">{m}</div>)}
              <div className="row">
                <select className="input" aria-label="Wallet" value={p.walletId ?? ''} onChange={(e) => patch(i, { walletId: Number(e.target.value) || null })}>
                  <option value="">Wallet…</option>
                  {real.map((w) => <option key={w.id} value={w.id}>{w.emoji} {w.name}</option>)}
                </select>
                {p.type === 'transfer' ? (
                  <select className="input" aria-label="To wallet" value={p.toWalletId ?? ''} onChange={(e) => patch(i, { toWalletId: Number(e.target.value) || null })}>
                    <option value="">To…</option>
                    {real.map((w) => <option key={w.id} value={w.id}>{w.emoji} {w.name}</option>)}
                  </select>
                ) : (
                  <select className="input" aria-label="Category" value={p.categoryId ?? ''} onChange={(e) => patch(i, { categoryId: Number(e.target.value) || null })}>
                    <option value="">Category…</option>
                    {categories.filter((c) => c.kind === p.type && !c.archived).map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
                  </select>
                )}
              </div>
              <div className="muted small">{p.type} · {wallet(p.walletId)?.name ?? 'no wallet'}{p.type !== 'transfer' ? ` · ${category(p.categoryId)?.name ?? 'no category'}` : ''}</div>
            </div>
          ))}
          {proposals.length > 0 && (
            <button className="btn" disabled={busy || proposals.some(bad)} onClick={() => save(proposals)}>
              Save {proposals.length} {proposals.length === 1 ? 'entry' : 'entries'}
            </button>
          )}
          </div>
          <aside className="card add-side desk-only" aria-label="Typing shortcuts">
            <div className="muted small" style={{ fontWeight: 700 }}>Typing shortcuts</div>
            {[['nasbung 16k @2', 'two separate entries'], ['nasbung 16k x2', 'one entry, 32.000'], ['gaji 8jt bca', 'income into BCA'], ['kopi 28k dan parkir 3k', 'several items at once'], ['transfer bca ke gopay 500k', 'between your wallets']].map(([a, b]) => (
              <div key={a} className="tip"><b>{a}</b><span className="muted small">{b}</span></div>
            ))}
          </aside>
        </div>
      ) : (
        <TxnForm
          busy={busy}
          submitLabel="Save"
          initial={{ type: 'expense', amount: '', walletId: defaultWallet, toWalletId: null, categoryId: null, description: '', date: today(), note: '' }}
          onSubmit={async (v) => {
            setBusy(true);
            setError('');
            try {
              await api.createBulk([{
                type: v.type, amount: toMinor(v.amount), walletId: v.walletId, toWalletId: v.type === 'transfer' ? v.toWalletId : null,
                categoryId: v.type === 'transfer' ? null : v.categoryId, description: v.description, note: v.note || null,
                occurredAt: v.date === today() ? undefined : v.date, source: 'manual',
              }]);
              await reload();
              nav('/');
            } catch (e) {
              setError(e instanceof ApiError ? e.message : 'Could not save');
              setBusy(false);
            }
          }}
        />
      )}
    </>
  );
}

