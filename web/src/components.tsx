import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, type AuditRow, type Txn } from './api';
import { decimalToMinor, formatMoney } from '../../shared/money';
import { useStore } from './store';

const SOURCE_LABEL: Record<string, string> = { manual: 'Manual', typed: 'Typed', notification: 'Auto', 'import:csv': 'Import' };

/** With `onEdit` the row becomes a div (a button can't nest the Edit button) and gains an Actions cell on desktop. */
export function TxnRow({ t, onOpen, onEdit }: { t: Txn; onOpen: (t: Txn) => void; onEdit?: (t: Txn) => void }) {
  const { wallet, category, money } = useStore();
  const cat = category(t.categoryId);
  const isTransfer = t.type === 'transfer';
  const emoji = isTransfer ? '🔁' : cat?.emoji ?? '📦';
  const title = t.description || (isTransfer ? 'Transfer' : cat?.name) || 'Entry';
  const sub = isTransfer ? `${wallet(t.walletId)?.name} → ${wallet(t.toWalletId)?.name}` : `${cat?.name ?? ''} · ${wallet(t.walletId)?.name ?? ''}`;
  const Tag = onEdit ? 'div' : 'button';
  return (
    <Tag className={`item${onEdit ? ' with-act' : ''}`} onClick={() => onOpen(t)}>
      <span className="emoji" aria-hidden="true">{emoji}</span>
      <span className="grow">
        <span className="ellipsis" style={{ display: 'block', fontWeight: 700, fontSize: 15 }}>{title}</span>
        <span className="muted small ellipsis" style={{ display: 'block' }}>{sub}{t.source.startsWith('import') ? ' · import' : ''}</span>
      </span>
      <span className="col-cat ellipsis">{isTransfer ? 'Transfer' : cat?.name ?? ''}</span>
      <span className="col-wallet ellipsis">{isTransfer ? `${wallet(t.walletId)?.name} → ${wallet(t.toWalletId)?.name}` : wallet(t.walletId)?.name ?? ''}</span>
      <span className="col-src muted">{SOURCE_LABEL[t.source] ?? t.source}</span>
      <span className={`amount ${t.type === 'income' ? 'in' : ''}`}>{t.type === 'income' ? '+' : ''}{money(t.amount)}</span>
      {onEdit && (
        <span className="col-act">
          <button type="button" className="act-btn" aria-label={`Edit ${title}`} onClick={(e) => { e.stopPropagation(); onEdit(t); }}>✎ Edit</button>
        </span>
      )}
    </Tag>
  );
}

export interface SelectOption { value: string; label: string; emoji?: string }

/** Searchable single-select (select2-style): type to filter, arrows + Enter to pick, Esc to close. The first option is the "all" choice. */
export function SearchSelect({ value, onChange, options, allLabel, ariaLabel }: {
  value: string; onChange: (v: string) => void; options: SelectOption[]; allLabel: string; ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const all: SelectOption[] = [{ value: '', label: allLabel }, ...options];
  const shown = all.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()));
  const cur = all.find((o) => o.value === value) ?? all[0]!;
  const close = () => { setOpen(false); setQ(''); };

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [open]);
  useEffect(() => { if (open) box.current?.querySelector('[data-hi="true"]')?.scrollIntoView?.({ block: 'nearest' }); }, [hi, open]);

  const pick = (o?: SelectOption) => { if (!o) return; onChange(o.value); close(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(shown[hi]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };

  return (
    <div className="ss" ref={box}>
      <button type="button" className={`input ss-btn${value ? ' ss-on' : ''}`} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} onClick={() => { setHi(Math.max(0, all.findIndex((o) => o.value === value))); if (open) close(); else setOpen(true); }}>
        <span className="ellipsis">{cur.emoji ? `${cur.emoji} ` : ''}{cur.label}</span><span aria-hidden="true" className="ss-caret">▾</span>
      </button>
      {open && (
        <div className="ss-pop">
          <input ref={search} className="input ss-q" type="search" placeholder="Search…" aria-label={`Search ${ariaLabel.toLowerCase()}`} value={q} onChange={(e) => { setQ(e.target.value); setHi(0); }} onKeyDown={onKey} />
          <div className="ss-list" role="listbox" aria-label={ariaLabel}>
            {shown.map((o, i) => (
              <button type="button" key={o.value || 'all'} role="option" aria-selected={o.value === value} data-hi={i === hi} className={`ss-opt${i === hi ? ' hi' : ''}${o.value === value ? ' sel' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => pick(o)}>
                <span className="ss-emo" aria-hidden="true">{o.emoji ?? ''}</span><span className="ellipsis">{o.label}</span>{o.value === value && <span aria-hidden="true">✓</span>}
              </button>
            ))}
            {shown.length === 0 && <div className="muted small ss-none">No match</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Portalled: inside `.screen` the desktop `> *` width cap would shrink the fixed overlay.
  return createPortal(
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h1 style={{ fontSize: 20 }}>{title}</h1>
          <button className="btn ghost" onClick={onClose} aria-label="Close">Close</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Toast({ text }: { text: string }) {
  return createPortal(<div className="toast" role="status">{text}</div>, document.body);
}

/** Amount fields show Indonesian grouping: dot for thousands, comma for decimals ("1.250.000,5"). */
export function formatAmountText(text: string, allowNegative = false): string {
  const neg = allowNegative && text.trim().startsWith('-') ? '-' : '';
  const [whole = '', ...rest] = text.replace(/[^\d,]/g, '').split(',');
  const grouped = whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const frac = rest.join('').slice(0, 2);
  return `${neg}${grouped}${rest.length ? ',' + frac : ''}`;
}

export const toMinor = (text: string) => decimalToMinor(text.replace(/[\s.]/g, '').replace(',', '.'), 2);
export const toInputAmount = (minor: number) => {
  const frac = minor % 100;
  return formatAmountText(frac ? `${Math.trunc(minor / 100)},${String(frac).padStart(2, '0')}` : String(Math.trunc(minor / 100)));
};

/** Text input that regroups digits as you type and keeps the caret next to the digit you edited. */
export function AmountInput({ value, onChange, allowNegative, ...rest }: {
  value: string; onChange: (v: string) => void; allowNegative?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current !== null && ref.current) ref.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  return (
    <input
      {...rest}
      ref={ref}
      inputMode="decimal"
      value={value}
      onChange={(e) => {
        const raw = e.target.value;
        const pos = e.target.selectionStart ?? raw.length;
        const sig = (s: string) => s.replace(/[^\d,-]/g, '').length;
        const next = formatAmountText(raw, allowNegative);
        // Put the caret after the same number of digits/commas it followed before regrouping.
        const want = sig(raw.slice(0, pos));
        let i = 0, seen = 0;
        while (i < next.length && seen < want) { if (/[\d,-]/.test(next[i]!)) seen++; i++; }
        caret.current = i;
        onChange(next);
      }}
    />
  );
}

interface FormValue {
  type: 'expense' | 'income' | 'transfer';
  amount: string;
  walletId: number;
  toWalletId: number | null;
  categoryId: number | null;
  description: string;
  date: string;
  note: string;
}

/** `quick`: compact layout, and 1-3 digit amounts mean thousands ("133" -> 133.000). For adding new entries only. `compact`: the compact layout alone. Enter saves from anywhere in the form. */
export function TxnForm({ initial, submitLabel, onSubmit, busy, quick, compact, autoFocus }: { initial: FormValue; submitLabel: string; onSubmit: (v: FormValue) => void; busy?: boolean; quick?: boolean; compact?: boolean; autoFocus?: boolean }) {
  const { wallets, categories } = useStore();
  const [v, setV] = useState(initial);
  const set = <K extends keyof FormValue>(k: K, val: FormValue[K]) => setV((p) => ({ ...p, [k]: val }));
  const real = wallets.filter((w) => !w.archived && (w.kind !== 'history' || v.type !== 'transfer'));
  const cats = categories.filter((c) => !c.archived && c.kind === v.type).sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0));
  const thousands = quick && /^\d{1,3}$/.test(v.amount);
  const amount = thousands ? `${v.amount}.000` : v.amount;
  const amountOk = toMinor(amount) !== null && toMinor(amount)! > 0;
  const ready = amountOk && v.walletId && (v.type === 'transfer' ? v.toWalletId && v.toWalletId !== v.walletId : v.categoryId);
  const dense = quick || compact;
  const save = () => { if (ready && !busy) onSubmit({ ...v, amount }); };

  return (
    <form
      className={`card${dense ? ' txn-quick' : ''}`}
      style={dense ? undefined : { display: 'flex', flexDirection: 'column', gap: 12 }}
      onSubmit={(e) => { e.preventDefault(); save(); }}
      onKeyDown={(e) => {
        // Chips, selects and the date field don't submit on Enter by themselves.
        if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || (e.target as HTMLElement).closest('textarea, button[type=submit], .btn')) return;
        e.preventDefault();
        save();
      }}>
      <div className="seg" role="group" aria-label="Type">
        {(['expense', 'income', 'transfer'] as const).map((t) => (
          <button type="button" key={t} aria-pressed={v.type === t} onClick={() => setV((p) => ({ ...p, type: t, categoryId: null, toWalletId: null }))}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="field q-amt">
        <label htmlFor="amt">Amount (Rp)</label>
        <div className="amt-wrap">
          <AmountInput id="amt" className="input" autoFocus={autoFocus} value={v.amount} onChange={(x) => set('amount', x)} placeholder="16.000" />
          {thousands && <span className="amt-ghost" aria-hidden="true"><i>{v.amount}</i>.000</span>}
        </div>
        {v.amount && !amountOk && <span className="err">Enter a number, e.g. 16.000</span>}
      </div>
      <div className="field q-wal">
        <label htmlFor="wal">{v.type === 'transfer' ? 'From' : 'Wallet'}</label>
        <select id="wal" className="input" value={v.walletId} onChange={(e) => set('walletId', Number(e.target.value))}>
          {real.map((w) => <option key={w.id} value={w.id}>{w.emoji} {w.name}</option>)}
        </select>
      </div>
      {v.type === 'transfer' ? (
        <div className="field q-cat">
          <label htmlFor="to">To</label>
          <select id="to" className="input" value={v.toWalletId ?? ''} onChange={(e) => set('toWalletId', Number(e.target.value) || null)}>
            <option value="">Choose…</option>
            {real.filter((w) => w.id !== v.walletId).map((w) => <option key={w.id} value={w.id}>{w.emoji} {w.name}</option>)}
          </select>
        </div>
      ) : (
        <div className="field q-cat">
          <label>Category</label>
          <div className="chips" role="group" aria-label="Category">
            {cats.map((c) => (
              <button type="button" key={c.id} className={`chip ${v.categoryId === c.id ? 'on' : ''}`} aria-pressed={v.categoryId === c.id} onClick={() => set('categoryId', c.id)}>
                <span aria-hidden="true">{v.categoryId === c.id ? '✓' : c.emoji}</span>{c.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="field q-desc">
        <label htmlFor="desc">Description</label>
        <input id="desc" className="input" placeholder="Description" value={v.description} onChange={(e) => set('description', e.target.value)} maxLength={200} />
      </div>
      <div className="field q-date">
        <label htmlFor="date">Date</label>
        <input id="date" className="input" type="date" value={v.date} onChange={(e) => set('date', e.target.value)} />
      </div>
      <div className="field q-note">
        <label htmlFor="note">Note</label>
        <input id="note" className="input" placeholder="Note" value={v.note} onChange={(e) => set('note', e.target.value)} maxLength={1000} />
      </div>
      <button className="btn block q-btn" disabled={!ready || busy}>{submitLabel}</button>
    </form>
  );
}

export function TxnSheet({ txn, onClose, onChanged, startEditing = false }: { txn: Txn; onClose: () => void; onChanged: () => void; startEditing?: boolean }) {
  const { reload } = useStore();
  const [history, setHistory] = useState<AuditRow[]>([]);
  const [editing, setEditing] = useState(startEditing);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.transaction(txn.id).then((d) => setHistory(d.history)).catch(() => undefined);
  }, [txn.id]);

  const done = async () => {
    await reload();
    onChanged();
    onClose();
  };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await done();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong');
      setBusy(false);
    }
  };

  return (
    <Sheet title={editing ? 'Edit entry' : 'Entry'} onClose={onClose}>
      {error && <div className="err" role="alert">{error}</div>}
      {editing ? (
        <TxnForm
          compact
          autoFocus
          busy={busy}
          submitLabel="Save changes"
          initial={{ type: txn.type, amount: toInputAmount(txn.amount), walletId: txn.walletId, toWalletId: txn.toWalletId, categoryId: txn.categoryId, description: txn.description, date: txn.localDate, note: txn.note ?? '' }}
          onSubmit={(v) => run(() => api.update(txn.id, {
            type: v.type, amount: toMinor(v.amount), walletId: v.walletId, toWalletId: v.type === 'transfer' ? v.toWalletId : null,
            categoryId: v.type === 'transfer' ? null : v.categoryId, description: v.description,
            occurredAt: v.date === txn.localDate ? txn.occurredAt : v.date, note: v.note || null,
          }))}
        />
      ) : (
        <>
          <Detail txn={txn} />
          <div className="row">
            <button className="btn grow" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn danger" disabled={busy} onClick={() => { if (confirm('Void this entry? It stays in the history but stops counting.')) void run(() => api.void(txn.id)); }}>Void</button>
          </div>
          {history.length > 0 && (
            <div className="card">
              <b style={{ fontSize: 13 }}>Change history</b>
              {history.map((h) => (
                <div key={h.id} className="muted small" style={{ marginTop: 6 }}>{h.at.slice(0, 16).replace('T', ' ')} UTC · {h.action}{h.reason ? ` (${h.reason})` : ''}</div>
              ))}
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}

function Detail({ txn }: { txn: Txn }) {
  const { wallet, category } = useStore();
  const rows: [string, string][] = [
    ['Amount', formatMoney(txn.amount, 'en')],
    ['Type', txn.type],
    ['Wallet', txn.type === 'transfer' ? `${wallet(txn.walletId)?.name} → ${wallet(txn.toWalletId)?.name}` : wallet(txn.walletId)?.name ?? ''],
    ['Category', category(txn.categoryId)?.name ?? '—'],
    ['When', txn.occurredAt.slice(0, 16).replace('T', ' ')],
    ['Source', txn.source],
    ['Note', txn.note ?? '—'],
  ];
  return (
    <div className="card flush">
      <div className="item" style={{ cursor: 'default' }}><b style={{ fontSize: 17 }}>{txn.description || '(no description)'}</b></div>
      {rows.map(([k, val]) => (
        <div className="item" style={{ cursor: 'default', minHeight: 44 }} key={k}><span className="muted grow">{k}</span><span>{val}</span></div>
      ))}
    </div>
  );
}
