import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api';
import { invApi, type Holding, type HoldingDetail, type HoldingKind, type Portfolio, type TradeKind } from '../api-investments';
import { AmountInput, Sheet, toInputAmount, toMinor } from '../components';
import { useStore } from '../store';
import './investments.css';
import './desk-invest.css';

const KIND_LABEL: Record<HoldingKind, string> = { sbn: 'SBN', stock: 'Stocks', fund: 'Funds & ETFs', gold: 'Gold', cash: 'Cash', other: 'Other' };
const KINDS = Object.keys(KIND_LABEL) as HoldingKind[];
const TRADE_LABEL: Record<TradeKind, string> = { buy: 'Buy', sell: 'Sell', income: 'Income' };

const jakartaToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const shortDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function formatUnits(unitsE4: number): string {
  const frac = String(unitsE4 % 10_000).padStart(4, '0').replace(/0+$/, '');
  return `${Math.trunc(unitsE4 / 10_000)}${frac ? ',' + frac : ''}`;
}
/** Average cost per unit in minor units, integer maths. */
const avgCost = (h: Pick<Holding, 'cost' | 'unitsE4'>) => (h.unitsE4 > 0 ? Number((BigInt(h.cost) * 20_000n + BigInt(h.unitsE4)) / (BigInt(h.unitsE4) * 2n)) : 0);
const pct = (bp: number) => `${bp >= 0 ? '+' : '−'}${(Math.abs(bp) / 100).toFixed(1).replace('.', ',')}%`;
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

type SheetState =
  | { t: 'add' }
  | { t: 'prices' }
  | { t: 'holding'; id: number }
  | { t: 'trade'; id: number; kind: TradeKind }
  | { t: 'price'; id: number };

export function InvestmentsPage() {
  const { money } = useStore();
  const [p, setP] = useState<Portfolio | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setP(await invApi.list());
    } catch {
      setError('Could not load investments. Check your connection.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const close = () => setSheet(null);
  const done = () => { void load(); };

  const valueParts = (n: number) => money(n).replace(/^Rp\s?/, '');

  return (
    <div className="inv">
      <div className="row inv-head">
        <Link to="/wallets" className="btn ghost inv-back" aria-label="Back to wallets" style={{ width: 44, minHeight: 44, padding: 0 }}>‹</Link>
        <div className="grow">
          <div className="muted small inv-eyebrow">Tracked separately from your wallets</div>
          <h1>Investments</h1>
        </div>
      </div>
      {error && <div className="notice" role="alert">{error}</div>}

      {p && (
        <>
          <div className="inv-top">
          <section className="card hero" aria-label="Portfolio value">
            <div className="label">Portfolio value</div>
            <div className="value"><span>Rp</span>{valueParts(p.value)}</div>
            {p.pricedCost > 0 && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span className={`gain ${p.gain < 0 ? 'neg' : ''}`}>{p.gain >= 0 ? '+' : '−'}{money(Math.abs(p.gain))} ({pct(p.gainBp)})</span>
                <span className="fine">simple gain, not time-weighted</span>
              </div>
            )}
            <div className="tags">
              {p.pricesAsOf && <span className="tag">Prices as of {shortDate(p.pricesAsOf)}</span>}
              {p.priceMissing > 0 && <span className="tag warn">{p.priceMissing} price{p.priceMissing === 1 ? '' : 's'} missing</span>}
            </div>
            <div className="income"><span>Coupons &amp; dividends in {p.year}</span><b className="num">{money(p.incomeYtd)}</b></div>
          </section>

          {p.allocation.length > 0 && (
            <section className="card" aria-label="Allocation">
              <div className="row between small"><b>Allocation</b><span className="muted">by value</span></div>
              <div className="alloc" role="img" style={{ marginTop: 10 }} aria-label={`Allocation: ${p.allocation.map((a) => `${KIND_LABEL[a.kind]} ${a.percent} percent`).join(', ')}.`}>
                {p.allocation.map((a) => <div key={a.kind} className={`k-${a.kind}`} style={{ width: `${a.percent}%` }} />)}
              </div>
              <div className="legend">
                {p.allocation.map((a) => <span key={a.kind}><span className={`dot k-${a.kind}`} /><span className="lg-l">{KIND_LABEL[a.kind]}</span>{' '}<span className="lg-p">{a.percent}%</span></span>)}
              </div>
            </section>
          )}
          </div>

          <h2>Holdings</h2>
          {p.holdings.length === 0 ? (
            <div className="card muted" style={{ textAlign: 'center' }}>No holdings yet. Add one to start tracking it.</div>
          ) : (
            <div className="card flush inv-table">
              <div className="inv-thead" aria-hidden="true">
                <span>Instrument</span><span className="r">Units</span><span className="r">Avg cost</span><span className="r">Price</span><span className="r">Value</span><span className="r">Gain</span>
              </div>
              {p.holdings.map((h) => (
                <button key={h.id} className="item inv-row" onClick={() => setSheet({ t: 'holding', id: h.id })}>
                  <span className="inv-id">
                    <span className="tile" aria-hidden="true">{h.symbol.slice(0, 4).toUpperCase()}</span>
                    <span className="grow">
                      <b className="ellipsis" style={{ display: 'block', fontSize: 15 }}>{h.symbol}</b>
                      <span className="muted small ellipsis inv-sub-m" style={{ display: 'block' }}>
                        {h.unitsE4 > 0 ? `${formatUnits(h.unitsE4)} ${h.unitLabel} · avg ${money(avgCost(h))}` : `Sold out · ${KIND_LABEL[h.kind]}`}
                      </span>
                      <span className="muted small ellipsis inv-sub-d">{h.unitsE4 > 0 ? (h.name || KIND_LABEL[h.kind]) : `Sold out · ${KIND_LABEL[h.kind]}`}</span>
                    </span>
                  </span>
                  <span className="d-cell r num">{h.unitsE4 > 0 ? `${formatUnits(h.unitsE4)} ${h.unitLabel}` : '—'}</span>
                  <span className="d-cell r num">{h.unitsE4 > 0 ? money(avgCost(h)) : '—'}</span>
                  <span className="d-cell r num">{h.price !== null ? money(h.price) : h.unitsE4 > 0 ? <span className="add-price">Add price</span> : '—'}</span>
                  <span className="d-cell r num">{h.price === null && h.unitsE4 > 0 ? <span className="muted">cost {money(h.cost)}</span> : <b>{money(h.value)}</b>}</span>
                  <span className="d-cell r num">{h.gain !== null ? <span className={h.gain >= 0 ? 'gain-up' : 'gain-down'}>{h.gain >= 0 ? '+' : '−'}{money(Math.abs(h.gain))}</span> : '—'}</span>
                  <span className="inv-right" style={{ textAlign: 'right' }}>
                    {h.price === null && h.unitsE4 > 0 ? (
                      <><div className="add-price">Add price</div><div className="muted small num">cost {money(h.cost)}</div></>
                    ) : (
                      <><div className="amount">{money(h.value)}</div>
                        {h.gain !== null && <div className={`num ${h.gain >= 0 ? 'gain-up' : 'gain-down'}`}>{h.gain >= 0 ? '+' : '−'}{money(Math.abs(h.gain))}</div>}</>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="row inv-actions">
            <button className="btn ghost grow inv-add" onClick={() => setSheet({ t: 'add' })}>Add holding</button>
            <button className="btn grow inv-prices" disabled={p.holdings.length === 0} onClick={() => setSheet({ t: 'prices' })}>Update prices</button>
          </div>
          <div className="muted small inv-note" style={{ padding: '0 4px' }}>Tracked separately from your wallets. Buying or selling here does not change any wallet balance.</div>
        </>
      )}

      {sheet?.t === 'add' && <AddHolding onClose={close} onSaved={() => { close(); done(); }} />}
      {sheet?.t === 'prices' && p && <PricesSheet holdings={p.holdings} onClose={close} onSaved={() => { close(); done(); }} />}
      {sheet?.t === 'holding' && <HoldingSheet id={sheet.id} onClose={close} onAction={(s) => setSheet(s)} onChanged={done} />}
      {sheet?.t === 'trade' && <TradeSheet id={sheet.id} kind={sheet.kind} onClose={close} onSaved={() => { done(); setSheet({ t: 'holding', id: sheet.id }); }} />}
      {sheet?.t === 'price' && <PriceSheet id={sheet.id} onClose={close} onSaved={() => { done(); setSheet({ t: 'holding', id: sheet.id }); }} />}
    </div>
  );
}

function AddHolding({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<HoldingKind>('stock');
  const [unitLabel, setUnitLabel] = useState('');
  const [units, setUnits] = useState('');
  const [paid, setPaid] = useState('');
  const [date, setDate] = useState(jakartaToday());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const hasFirst = units.trim() !== '' || paid.trim() !== '';
  const paidMinor = toMinor(paid);
  const ready = symbol.trim() !== '' && (!hasFirst || (units.trim() !== '' && paidMinor !== null && paidMinor > 0));

  async function save() {
    setBusy(true);
    setError('');
    try {
      await invApi.create({
        symbol, name, kind, unitLabel: unitLabel || undefined,
        first: hasFirst ? { date, units, amount: paidMinor } : null,
      });
      onSaved();
    } catch (e) {
      setError(errText(e, 'Could not add the holding'));
      setBusy(false);
    }
  }

  return (
    <Sheet title="Add holding" onClose={onClose}>
      <form className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} onSubmit={(e) => { e.preventDefault(); if (ready) void save(); }}>
        <div className="field"><label htmlFor="hs">Symbol</label><input id="hs" className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={30} placeholder="BBCA" autoFocus /></div>
        <div className="field"><label htmlFor="hn">Name (optional)</label><input id="hn" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></div>
        <div className="field"><label htmlFor="hk">Type</label>
          <select id="hk" className="input" value={kind} onChange={(e) => setKind(e.target.value as HoldingKind)}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
        </div>
        <div className="field"><label htmlFor="hl">Unit name (optional)</label><input id="hl" className="input" value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} maxLength={12} placeholder="lot, g, units" /></div>
        <b style={{ fontSize: 13 }}>First purchase (optional)</b>
        <div className="field"><label htmlFor="hu">How many</label><input id="hu" className="input" inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="23" /></div>
        <div className="field"><label htmlFor="hp">Total paid (Rp)</label><AmountInput id="hp" className="input" value={paid} onChange={setPaid} placeholder="21.045.000" /></div>
        <div className="field"><label htmlFor="hd">Date</label><input id="hd" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        {error && <div className="err" role="alert">{error}</div>}
        <button className="btn block" disabled={!ready || busy}>Add holding</button>
      </form>
    </Sheet>
  );
}

function PricesSheet({ holdings, onClose, onSaved }: { holdings: Holding[]; onClose: () => void; onSaved: () => void }) {
  const { money } = useStore();
  const [vals, setVals] = useState<Record<number, string>>(() => Object.fromEntries(holdings.map((h) => [h.id, h.price === null ? '' : toInputAmount(h.price)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const changed = holdings.filter((h) => {
    const m = toMinor(vals[h.id] ?? '');
    return m !== null && m !== h.price;
  });

  async function save() {
    setBusy(true);
    setError('');
    try {
      const date = jakartaToday();
      for (const h of changed) await invApi.price(h.id, toMinor(vals[h.id]!)!, date);
      onSaved();
    } catch (e) {
      setError(errText(e, 'Could not save the prices'));
      setBusy(false);
    }
  }

  return (
    <Sheet title="Update prices" onClose={onClose}>
      <div className="muted small">Price for one unit, in rupiah. Rows you leave as they are stay unchanged.</div>
      <div className="card flush">
        {holdings.map((h) => (
          <div key={h.id} className="price-row">
            <span className="grow"><b>{h.symbol}</b><div className="muted small">per {h.unitLabel} · {h.priceDate ? `last ${shortDate(h.priceDate)}` : 'no price yet'}{h.price !== null ? ` · ${money(h.price)}` : ''}</div></span>
            <AmountInput className="input" aria-label={`Price of ${h.symbol}`} value={vals[h.id] ?? ''} onChange={(v) => setVals((s) => ({ ...s, [h.id]: v }))} placeholder="0" />
          </div>
        ))}
      </div>
      {error && <div className="err" role="alert">{error}</div>}
      <button className="btn block" disabled={changed.length === 0 || busy} onClick={() => void save()}>Save {changed.length || ''} price{changed.length === 1 ? '' : 's'}</button>
    </Sheet>
  );
}

function HoldingSheet({ id, onClose, onAction, onChanged }: { id: number; onClose: () => void; onAction: (s: SheetState) => void; onChanged: () => void }) {
  const { money } = useStore();
  const [d, setD] = useState<HoldingDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { invApi.detail(id).then(setD).catch(() => setError('Could not load this holding.')); }, [id]);

  async function archive() {
    if (!confirm('Archive this holding? It stops counting in the portfolio. Its trades are kept.')) return;
    try {
      await invApi.archive(id);
      onChanged();
      onClose();
    } catch (e) {
      setError(errText(e, 'Could not archive'));
    }
  }

  return (
    <Sheet title={d?.symbol ?? 'Holding'} onClose={onClose}>
      {error && <div className="err" role="alert">{error}</div>}
      {d && (
        <>
          <div className="card flush">
            {([
              ['Held', d.unitsE4 > 0 ? `${formatUnits(d.unitsE4)} ${d.unitLabel}` : 'Nothing'],
              ['Cost', money(d.cost)],
              ['Price', d.price === null ? 'Not set' : `${money(d.price)} per ${d.unitLabel}${d.priceDate ? ` · ${shortDate(d.priceDate)}` : ''}`],
              ['Value', money(d.value)],
              ['Gain', d.gain === null ? '—' : `${d.gain >= 0 ? '+' : '−'}${money(Math.abs(d.gain))}`],
              ['Income this year', money(d.incomeYtd)],
              ['Type', KIND_LABEL[d.kind]],
            ] as const).map(([k, v]) => <div className="kv" key={k}><span className="muted">{k}</span><span className="num">{v}</span></div>)}
          </div>
          <div className="actions">
            <button className="btn" onClick={() => onAction({ t: 'trade', id, kind: 'buy' })}>Buy</button>
            <button className="btn ghost" disabled={d.unitsE4 === 0} onClick={() => onAction({ t: 'trade', id, kind: 'sell' })}>Sell</button>
            <button className="btn ghost" onClick={() => onAction({ t: 'trade', id, kind: 'income' })}>Record income</button>
            <button className="btn ghost" onClick={() => onAction({ t: 'price', id })}>Update price</button>
          </div>
          <h2>Trades</h2>
          {d.trades.length === 0 ? (
            <div className="card muted" style={{ textAlign: 'center' }}>No trades yet.</div>
          ) : (
            <div className="card flush">
              {d.trades.map((t) => (
                <div className="kv" key={t.id}>
                  <span><b>{TRADE_LABEL[t.kind]}</b> <span className="muted small">{shortDate(t.date)}{t.kind !== 'income' ? ` · ${formatUnits(t.unitsE4)} ${d.unitLabel}` : ''}</span></span>
                  <span className="num">{t.kind === 'buy' ? '−' : '+'}{money(t.amount)}</span>
                </div>
              ))}
            </div>
          )}
          <button className="btn danger" onClick={() => void archive()}>Archive holding</button>
        </>
      )}
    </Sheet>
  );
}

function TradeSheet({ id, kind, onClose, onSaved }: { id: number; kind: TradeKind; onClose: () => void; onSaved: () => void }) {
  const [units, setUnits] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(jakartaToday());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const minor = toMinor(amount);
  const ready = minor !== null && minor > 0 && (kind === 'income' || units.trim() !== '');
  const amountLabel = kind === 'buy' ? 'Total paid (Rp)' : kind === 'sell' ? 'Total received (Rp)' : 'Amount received (Rp)';

  async function save() {
    setBusy(true);
    setError('');
    try {
      await invApi.trade(id, { kind, date, units: kind === 'income' ? '0' : units, amount: minor! });
      onSaved();
    } catch (e) {
      setError(errText(e, 'Could not save the trade'));
      setBusy(false);
    }
  }

  return (
    <Sheet title={kind === 'income' ? 'Record income' : TRADE_LABEL[kind]} onClose={onClose}>
      <form className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} onSubmit={(e) => { e.preventDefault(); if (ready) void save(); }}>
        {kind !== 'income' && <div className="field"><label htmlFor="tu">How many</label><input id="tu" className="input" inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="23" autoFocus /></div>}
        <div className="field"><label htmlFor="ta">{amountLabel}</label><AmountInput id="ta" className="input" value={amount} onChange={setAmount} placeholder="0" autoFocus={kind === 'income'} /></div>
        <div className="field"><label htmlFor="td">Date</label><input id="td" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        {error && <div className="err" role="alert">{error}</div>}
        <button className="btn block" disabled={!ready || busy}>Save</button>
      </form>
    </Sheet>
  );
}

function PriceSheet({ id, onClose, onSaved }: { id: number; onClose: () => void; onSaved: () => void }) {
  const [price, setPrice] = useState('');
  const [date, setDate] = useState(jakartaToday());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const minor = toMinor(price);

  async function save() {
    setBusy(true);
    setError('');
    try {
      await invApi.price(id, minor!, date);
      onSaved();
    } catch (e) {
      setError(errText(e, 'Could not save the price'));
      setBusy(false);
    }
  }

  return (
    <Sheet title="Update price" onClose={onClose}>
      <form className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} onSubmit={(e) => { e.preventDefault(); if (minor !== null) void save(); }}>
        <div className="field"><label htmlFor="pp">Price for one unit (Rp)</label><AmountInput id="pp" className="input" value={price} onChange={setPrice} placeholder="0" autoFocus /></div>
        <div className="field"><label htmlFor="pd">As of</label><input id="pd" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        {error && <div className="err" role="alert">{error}</div>}
        <button className="btn block" disabled={minor === null || busy}>Save price</button>
      </form>
    </Sheet>
  );
}
