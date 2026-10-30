import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { holdings, holdingTrades } from '../db/schema.js';
import { LedgerError } from './ledger.js';
import { today } from './time.js';

// Investments are tracked apart from the wallet ledger: nothing here touches transactions or journal lines.
// Units are stored as integers scaled by 10_000; money is integer minor units. All maths is integer (BigInt).

export const HOLDING_KINDS = ['sbn', 'stock', 'fund', 'gold', 'cash', 'other'] as const;
export type HoldingKind = (typeof HOLDING_KINDS)[number];
export type HoldingRow = typeof holdings.$inferSelect;
export type TradeRow = typeof holdingTrades.$inferSelect;
export type TradeKind = 'buy' | 'sell' | 'income';

const E4 = 10_000n;

/** "23", "0.5", "1,25" -> units * 10_000. Up to 4 decimals, no sign. */
export function parseUnits(text: string): number {
  const t = text.trim().replace(',', '.');
  const m = /^(\d{1,12})(?:\.(\d{1,4}))?$/.exec(t);
  if (!m) throw new LedgerError('Units should be a number with up to 4 decimals');
  return Number(BigInt(m[1]!) * E4 + BigInt((m[2] ?? '').padEnd(4, '0')));
}

export function formatUnits(unitsE4: number): string {
  const whole = Math.trunc(unitsE4 / 10_000);
  const frac = String(unitsE4 % 10_000).padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole},${frac}` : String(whole);
}

function safe(n: bigint, what: string): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) throw new LedgerError(`${what} is too large`);
  return Number(n);
}

/** a * b / d rounded half up, for non-negative integers. */
function mulDiv(a: number, b: number, d: number): bigint {
  return (BigInt(a) * BigInt(b) * 2n + BigInt(d)) / (BigInt(d) * 2n);
}

/** Market value when a price exists, otherwise what it cost. */
export function holdingValue(h: Pick<HoldingRow, 'unitsE4' | 'price' | 'cost'>): number {
  if (h.price === null) return h.cost;
  return safe(mulDiv(h.unitsE4, h.price, 10_000), 'Value');
}

const jakartaYear = (date = today()) => date.slice(0, 4);

function must(db: Db, id: number): HoldingRow {
  const h = db.select().from(holdings).where(eq(holdings.id, id)).get();
  if (!h) throw new LedgerError('Holding not found', 404);
  return h;
}

export interface NewHolding {
  symbol: string;
  name?: string;
  kind: HoldingKind;
  unitLabel?: string;
  note?: string | null;
  price?: number | null;
  priceDate?: string | null;
  first?: { date: string; unitsE4: number; amount: number } | null;
}

export function createHolding(db: Db, input: NewHolding): HoldingRow {
  return db.transaction((tx) => {
    const symbol = input.symbol.trim();
    if (!symbol) throw new LedgerError('Give the holding a symbol');
    const row = tx.insert(holdings).values({
      symbol,
      name: input.name ?? '',
      kind: input.kind,
      unitLabel: input.unitLabel || (input.kind === 'stock' ? 'lot' : input.kind === 'gold' ? 'g' : 'units'),
      note: input.note ?? null,
      price: input.price ?? null,
      priceDate: input.price != null ? input.priceDate ?? today() : null,
    }).returning().get();
    if (input.first) applyTrade(tx as unknown as Db, row.id, { kind: 'buy', ...input.first });
    return must(tx as unknown as Db, row.id);
  });
}

export interface TradeInput {
  kind: TradeKind;
  date: string;
  unitsE4: number;
  amount: number;
}

function applyTrade(db: Db, id: number, t: TradeInput): TradeRow {
  const h = must(db, id);
  if (!Number.isSafeInteger(t.amount) || t.amount <= 0) throw new LedgerError('Enter an amount above zero');
  let unitsE4 = h.unitsE4;
  let cost = h.cost;
  let incomeYtd = h.incomeYtd;
  if (t.kind === 'buy') {
    if (t.unitsE4 <= 0) throw new LedgerError('Enter how many units you bought');
    unitsE4 = safe(BigInt(h.unitsE4) + BigInt(t.unitsE4), 'Units');
    cost = safe(BigInt(h.cost) + BigInt(t.amount), 'Cost');
  } else if (t.kind === 'sell') {
    if (t.unitsE4 <= 0) throw new LedgerError('Enter how many units you sold');
    if (t.unitsE4 > h.unitsE4) throw new LedgerError('You cannot sell more than you hold');
    const released = t.unitsE4 === h.unitsE4 ? h.cost : Math.min(h.cost, Number(mulDiv(h.cost, t.unitsE4, h.unitsE4)));
    unitsE4 = h.unitsE4 - t.unitsE4;
    cost = h.cost - released;
  } else if (jakartaYear(t.date) === jakartaYear()) {
    incomeYtd = safe(BigInt(h.incomeYtd) + BigInt(t.amount), 'Income');
  }
  const row = db.insert(holdingTrades).values({
    holdingId: id,
    kind: t.kind,
    date: t.date,
    unitsE4: t.kind === 'income' ? 0 : t.unitsE4,
    amount: t.amount,
  }).returning().get();
  db.update(holdings).set({ unitsE4, cost, incomeYtd }).where(eq(holdings.id, id)).run();
  return row;
}

export function addTrade(db: Db, id: number, t: TradeInput): TradeRow {
  return db.transaction((tx) => applyTrade(tx as unknown as Db, id, t));
}

export function setPrice(db: Db, id: number, price: number, date = today()): HoldingRow {
  must(db, id);
  if (!Number.isSafeInteger(price) || price < 0) throw new LedgerError('Enter a price');
  return db.update(holdings).set({ price, priceDate: date }).where(eq(holdings.id, id)).returning().get();
}

export function archiveHolding(db: Db, id: number): HoldingRow {
  must(db, id);
  return db.update(holdings).set({ archived: true }).where(eq(holdings.id, id)).returning().get();
}

export function updateHolding(db: Db, id: number, patch: { name?: string; kind?: HoldingKind; unitLabel?: string; note?: string | null }): HoldingRow {
  must(db, id);
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (Object.keys(set).length === 0) return must(db, id);
  return db.update(holdings).set(set).where(eq(holdings.id, id)).returning().get();
}

export function holdingDetail(db: Db, id: number) {
  const h = must(db, id);
  const trades = db.select().from(holdingTrades).where(eq(holdingTrades.holdingId, id)).orderBy(desc(holdingTrades.date), desc(holdingTrades.id)).all();
  return { ...withValue(h), trades };
}

const withValue = (h: HoldingRow) => ({ ...h, value: holdingValue(h), gain: h.price === null ? null : holdingValue(h) - h.cost });

/** Whole percentages that always add up to 100 (largest remainder). */
export function shares(values: number[]): number[] {
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0) return values.map(() => 0);
  const raw = values.map((v) => (v * 100) / total);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

export function portfolio(db: Db) {
  const rows = db.select().from(holdings).where(and(eq(holdings.archived, false))).orderBy(asc(holdings.id)).all();
  const list = rows.map(withValue);
  const priced = list.filter((h) => h.price !== null);
  const value = list.reduce((s, h) => s + h.value, 0);
  const gain = priced.reduce((s, h) => s + (h.gain ?? 0), 0);
  const pricedCost = priced.reduce((s, h) => s + h.cost, 0);
  // Gain as basis points of the cost of priced holdings (810 = 8.10%).
  const gainBp = pricedCost > 0 ? Number((BigInt(gain) * 10_000n) / BigInt(pricedCost)) : 0;
  const kinds = HOLDING_KINDS.map((kind) => ({ kind, value: list.filter((h) => h.kind === kind).reduce((s, h) => s + h.value, 0) })).filter((k) => k.value > 0);
  const pct = shares(kinds.map((k) => k.value));
  const dates = priced.map((h) => h.priceDate ?? '').filter(Boolean).sort();
  return {
    value,
    gain,
    gainBp,
    pricedCost,
    priceMissing: list.filter((h) => h.price === null && h.unitsE4 > 0).length,
    pricesAsOf: dates.length ? dates[dates.length - 1]! : null,
    incomeYtd: list.reduce((s, h) => s + h.incomeYtd, 0),
    year: jakartaYear(),
    allocation: kinds.map((k, i) => ({ kind: k.kind, value: k.value, percent: pct[i]! })),
    holdings: list,
  };
}
