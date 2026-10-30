import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { capture, type ReviewItem } from '../api-capture';
import { Sheet, toInputAmount, toMinor, TxnForm } from '../components';
import { useStore } from '../store';
import './capture.css';

const TAGS: Record<ReviewItem['kind'], { label: string; cls: string }> = {
  paired_transfer: { label: 'Paired transfer', cls: 'good' },
  own_transfer: { label: 'Transfer', cls: 'good' },
  new_payment: { label: 'New payment', cls: 'warn' },
  new_income: { label: 'Money in', cls: 'warn' },
  possible_duplicate: { label: 'Possible duplicate', cls: 'warn' },
  unreadable: { label: 'Could not read', cls: 'warn' },
};

const hhmm = (iso: string) => iso.slice(11, 16);

export function ReviewPage() {
  const nav = useNavigate();
  const { money, wallets, categories, category, wallet, reload } = useStore();
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ReviewItem | null>(null);
  const [changing, setChanging] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await capture.pending()).items);
    } catch {
      setError('Could not load. Check your connection.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await fn();
      if (done) setNote(done);
      setChanging(null);
      setEditing(null);
      await Promise.all([load(), reload()]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const left = items?.length ?? 0;
  const closeDay = () => {
    if (left === 0) { nav('/'); return; }
    if (!confirm('Confirm everything that is ready as suggested? Duplicates and unreadable items stay for you.')) return;
    void run(async () => {
      const r = await capture.closeDay();
      setNote(`${r.confirmed} confirmed${r.left ? `, ${r.left} still need you` : ''}.`);
    });
  };

  return (
    <>
      <div className="cap-head">
        <Link to="/" className="cap-back" aria-label="Back">←</Link>
        <div>
          <h1 className="cap-title">Close the day</h1>
          <div className="muted small">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} · {left} to review</div>
        </div>
      </div>
      {error && <div className="notice" role="alert">{error}</div>}
      {note && <div className="notice" role="status">{note}</div>}

      {items && items.length === 0 && (
        <div className="cap-card cap-empty">
          <b style={{ color: 'var(--ink)' }}>All caught up</b>
          <div>New bank and e-wallet notifications appear here for you to confirm.</div>
          <Link to="/settings/sources">Notification sources</Link>
        </div>
      )}

      {items?.map((it) => (
        <Card
          key={it.id}
          it={it}
          busy={busy}
          changing={changing === it.id}
          onChange={() => setChanging(changing === it.id ? null : it.id)}
          onConfirm={() => run(() => capture.confirm(it.id))}
          onPick={(categoryId) => run(() => capture.confirm(it.id, { categoryId }))}
          onEdit={() => setEditing(it)}
          onDismiss={() => { if (confirm('Dismiss this notification? Nothing will be recorded.')) void run(() => capture.dismiss(it.id)); }}
          onKeepOne={() => run(() => capture.keepOne(it.id))}
          onKeepBoth={() => run(() => capture.keepBoth(it.id))}
          money={money}
          walletName={(id) => wallet(id)?.name}
          emoji={category(it.categoryId)?.emoji}
          categoryName={category(it.categoryId)?.name}
          cats={categories.filter((c) => !c.archived && c.kind === it.type)}
        />
      ))}

      {items && (
        <button className="btn block" disabled={busy} onClick={closeDay}>
          {left === 0 ? 'Done' : `Close the day · ${left} left`}
        </button>
      )}

      {editing && (
        <Sheet title="Edit entry" onClose={() => setEditing(null)}>
          <TxnForm
            busy={busy}
            submitLabel="Save and confirm"
            initial={{
              type: editing.type,
              amount: editing.amount ? toInputAmount(editing.amount) : '',
              walletId: editing.walletId ?? wallets.find((w) => w.countsTowardTotal && !w.archived)?.id ?? 0,
              toWalletId: editing.toWalletId,
              categoryId: editing.categoryId,
              description: editing.description,
              date: editing.receivedAt.slice(0, 10),
              note: '',
            }}
            onSubmit={(v) => void run(() => capture.editConfirm(editing.id, {
              type: v.type, amount: toMinor(v.amount), walletId: v.walletId, toWalletId: v.type === 'transfer' ? v.toWalletId : null,
              categoryId: v.type === 'transfer' ? null : v.categoryId, description: v.description,
              occurredAt: v.date === editing.receivedAt.slice(0, 10) ? editing.receivedAt : v.date, note: v.note || null,
            }))}
          />
        </Sheet>
      )}
    </>
  );
}

function Card(p: {
  it: ReviewItem; busy: boolean; changing: boolean; money: (n: number) => string; walletName: (id: number | null) => string | undefined;
  emoji?: string; categoryName?: string; cats: { id: number; name: string; emoji: string }[];
  onChange: () => void; onConfirm: () => void; onPick: (id: number) => void; onEdit: () => void; onDismiss: () => void; onKeepOne: () => void; onKeepBoth: () => void;
}) {
  const { it } = p;
  const tag = TAGS[it.kind];
  const isTransfer = it.type === 'transfer';
  const title = isTransfer ? `${p.walletName(it.walletId) ?? '?'} → ${p.walletName(it.toWalletId) ?? '?'}` : it.description;
  const sub = isTransfer ? 'Not counted as spending or income'
    : it.kind === 'unreadable' ? 'Fill in the details to record it'
    : it.type === 'income' ? `Received in ${p.walletName(it.walletId) ?? it.appLabel}` : `Paid with ${p.walletName(it.walletId) ?? it.appLabel}`;
  const sign = it.type === 'income' ? '+' : isTransfer ? '' : '−';
  const times = it.kind === 'possible_duplicate' && it.other ? `${hhmm(it.other.receivedAt)} · ${hhmm(it.receivedAt)}` : hhmm(it.receivedAt);
  const gap = it.kind === 'possible_duplicate' && it.other ? Math.max(1, Math.round(Math.abs(Date.parse(it.receivedAt) - Date.parse(it.other.receivedAt)) / 60000)) : 0;
  const why = it.billName ? `Matches your ${it.billName} bill`
    : it.suggestedFrom > 0 ? `Suggested from ${it.suggestedFrom} earlier ${it.suggestedFrom === 1 ? 'entry' : 'entries'}`
    : 'Best guess. Change it if it is wrong.';

  return (
    <article className="cap-card" aria-label={title}>
      <div className="row between">
        <span className={`cap-tag ${tag.cls}`}>{tag.label}</span>
        <span className="muted small">{times}</span>
      </div>
      <div className="row">
        <span className="emoji" aria-hidden="true">{isTransfer ? '🔁' : it.kind === 'unreadable' ? '❓' : p.emoji ?? '📦'}</span>
        <span className="grow">
          <b className="ellipsis" style={{ display: 'block' }}>{title}</b>
          <span className="muted small ellipsis" style={{ display: 'block' }}>
            {it.kind === 'possible_duplicate' ? `Same amount twice in ${gap} ${gap === 1 ? 'minute' : 'minutes'}` : sub}
          </span>
        </span>
        <span className="amount">{it.amount ? `${sign}${p.money(it.amount)}` : '—'}</span>
      </div>

      {it.kind === 'paired_transfer' && it.other ? (
        <>
          <div className="cap-src"><b>{it.direction === 'out' ? it.appLabel : it.other.appLabel}</b> · {(it.direction === 'out' ? it.text : it.other.text) || '(original text deleted)'}</div>
          <div className="cap-src"><b>{it.direction === 'out' ? it.other.appLabel : it.appLabel}</b> · {(it.direction === 'out' ? it.other.text : it.text) || '(original text deleted)'}</div>
        </>
      ) : (
        <div className="cap-src"><b>{it.appLabel}</b> · {it.text || '(original text deleted)'}</div>
      )}

      {!isTransfer && it.kind !== 'unreadable' && it.kind !== 'possible_duplicate' && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span className="cap-tag">{p.categoryName ?? 'No category'}</span>
          <span className="muted small">{why}</span>
        </div>
      )}

      {p.changing && (
        <div className="chips" role="group" aria-label="Pick a category">
          {p.cats.map((c) => (
            <button key={c.id} className={`chip ${c.id === it.categoryId ? 'on' : ''}`} disabled={p.busy} onClick={() => p.onPick(c.id)}>
              <span aria-hidden="true">{c.emoji}</span>{c.name}
            </button>
          ))}
        </div>
      )}

      {it.kind === 'possible_duplicate' ? (
        <div className="cap-actions">
          <button className="btn grow" disabled={p.busy} onClick={p.onKeepOne}>Keep one</button>
          <button className="btn ghost" disabled={p.busy} onClick={p.onKeepBoth}>Both are real</button>
        </div>
      ) : it.kind === 'unreadable' ? (
        <div className="cap-actions">
          <button className="btn grow" disabled={p.busy} onClick={p.onEdit}>Edit</button>
          <button className="btn ghost" disabled={p.busy} onClick={p.onDismiss}>Dismiss</button>
        </div>
      ) : (
        <>
          <div className="cap-actions">
            <button className="btn grow" disabled={p.busy} onClick={p.onConfirm}>Confirm</button>
            {isTransfer
              ? <button className="btn ghost" disabled={p.busy} onClick={p.onEdit}>Edit</button>
              : <button className="btn ghost" disabled={p.busy} aria-expanded={p.changing} onClick={p.onChange}>Change</button>}
          </div>
          <div className="row" style={{ justifyContent: 'center', gap: 16 }}>
            {!isTransfer && <button className="cap-link" onClick={p.onEdit}>Edit details</button>}
            <button className="cap-link" onClick={p.onDismiss}>Dismiss</button>
          </div>
        </>
      )}
    </article>
  );
}
