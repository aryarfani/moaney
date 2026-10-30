import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Txn, type Wallet } from '../api';
import { planApi } from '../api-plan';
import { AmountInput, toMinor, TxnRow, TxnSheet } from '../components';
import { useStore } from '../store';
import { BackHeader } from './Settings';
import './plan.css';

const KIND_LABEL: Record<string, string> = {
  bank: 'Bank account', ewallet: 'E-wallet', cash: 'Cash', credit_card: 'Credit card', receivable: 'Owed to me', history: 'History only',
};

export function WalletDetailPage() {
  const { id } = useParams();
  const wid = Number(id);
  const nav = useNavigate();
  const { categories, money, reload } = useStore();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [recent, setRecent] = useState<Txn[]>([]);
  const [open, setOpen] = useState<Txn | null>(null);
  const [reported, setReported] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await planApi.walletDetail(wid);
      setWallet(d.wallet);
      setRecent(d.recent);
      setName(d.wallet.name);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load this wallet.');
    }
  }, [wid]);
  useEffect(() => { void load(); }, [load]);

  if (!wallet) return <><BackHeader to="/wallets" title="Wallet" />{error ? <div className="notice" role="alert">{error}</div> : <div className="muted">Loading…</div>}</>;

  const reportedMinor = reported.trim() ? toMinor(reported) : null;
  const diff = reportedMinor === null ? null : reportedMinor - wallet.balance;

  async function run(fn: () => Promise<unknown>, fail: string) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await Promise.all([load(), reload()]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : fail);
    } finally {
      setBusy(false);
    }
  }

  async function adjust() {
    if (diff === null || diff === 0) return;
    const up = diff > 0;
    const cat = categories.find((c) => c.name === (up ? 'Other income' : 'Others') && c.kind === (up ? 'income' : 'expense'));
    if (!cat) { setError(`Category "${up ? 'Other income' : 'Others'}" is missing. Add it under Categories first.`); return; }
    if (!confirm(`Record a ${up ? 'income' : 'expense'} of ${money(Math.abs(diff))} so ${wallet!.name} matches your bank?`)) return;
    await run(async () => {
      await api.createBulk([{ type: up ? 'income' : 'expense', amount: Math.abs(diff), walletId: wid, categoryId: cat.id, description: 'Balance adjustment', source: 'manual' }]);
      setReported('');
    }, 'Could not record the adjustment.');
  }

  return (
    <>
      <BackHeader to="/wallets" title={wallet.name} sub={KIND_LABEL[wallet.kind] ?? wallet.kind} />
      {error && <div className="notice" role="alert">{error}</div>}

      <section className="card" aria-label="Balance">
        <div className="muted small">Balance in Moaney</div>
        <div className="big">{money(wallet.balance)}</div>
      </section>

      {wallet.countsTowardTotal && (
        <section className="card amber-card stack" aria-label="Check against your bank">
          <b>Check against your bank</b>
          <div className="field">
            <label htmlFor="rep">Balance your bank shows (Rp)</label>
            <AmountInput id="rep" className="input" allowNegative value={reported} onChange={setReported} placeholder="0" />
            {reported && reportedMinor === null && <span className="err">Enter a number, e.g. 13.475.020</span>}
          </div>
          {diff !== null && (
            <>
              <div className="kv"><span className="muted">Reported balance</span><b className="num">{money(reportedMinor!)}</b></div>
              <div className="kv"><span className="muted">Difference</span><b className="num" style={{ color: diff === 0 ? 'var(--accent-ink)' : 'var(--warn)' }}>{money(Math.abs(diff))}</b></div>
              <div className="notice" style={{ borderWidth: 0 }}>
                {diff === 0
                  ? 'Moaney matches your bank.'
                  : `Moaney shows ${money(Math.abs(diff))} ${diff > 0 ? 'less' : 'more'} than the bank. A notification may be missing, or a transfer was not recorded.`}
              </div>
              {diff !== 0 && <button className="btn" disabled={busy} onClick={() => void adjust()}>Record adjustment</button>}
            </>
          )}
        </section>
      )}

      <h2>Recent activity</h2>
      {recent.length === 0 ? (
        <div className="card muted" style={{ textAlign: 'center' }}>Nothing recorded in this wallet yet.</div>
      ) : (
        <div className="card flush">{recent.map((t) => <TxnRow key={t.id} t={t} onOpen={setOpen} />)}</div>
      )}

      {renaming ? (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); void run(async () => { await planApi.patchWallet(wid, { name }); setRenaming(false); }, 'Could not rename.'); }}>
          <div className="field"><label htmlFor="rn">Wallet name</label><input id="rn" className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus /></div>
          <div className="row"><button className="btn grow" disabled={!name.trim() || busy}>Save name</button><button type="button" className="btn ghost" onClick={() => { setRenaming(false); setName(wallet.name); }}>Cancel</button></div>
        </form>
      ) : (
        <div className="row">
          <button className="btn outline grow" onClick={() => setRenaming(true)}>Rename</button>
          <button className="btn outline grow" disabled={busy} onClick={() => {
            if (confirm(`Archive ${wallet.name}? Its history stays, but it leaves your wallet list.`)) void run(async () => { await planApi.patchWallet(wid, { archived: true }); nav('/wallets'); }, 'Could not archive.');
          }}>Archive wallet</button>
        </div>
      )}
      {open && <TxnSheet txn={open} onClose={() => setOpen(null)} onChanged={() => void load()} />}
    </>
  );
}
