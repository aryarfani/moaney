import { and, eq, gte, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { categories, transactions } from '../db/schema.js';
import { addDays, today as jakartaToday } from './time.js';

export type Period = 'daily' | 'weekly' | 'monthly' | 'yearly';
export const PERIODS: readonly Period[] = ['daily', 'weekly', 'monthly', 'yearly'];

export interface Range {
  from: string;
  to: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayOfWeekMon0 = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000) + 1;

/** The calendar period that contains `date` (weeks start on Monday). */
export function periodRange(period: Period, date: string): Range {
  const [y, m] = date.split('-').map(Number) as [number, number, number];
  if (period === 'daily') return { from: date, to: date };
  if (period === 'weekly') {
    const from = addDays(date, -dayOfWeekMon0(date));
    return { from, to: addDays(from, 6) };
  }
  if (period === 'monthly') return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(daysInMonth(y, m))}` };
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

/** A date inside the previous (dir -1) or next (dir 1) period, clamped to a valid day. */
export function stepPeriod(period: Period, date: string, dir: 1 | -1): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  if (period === 'daily') return addDays(date, dir);
  if (period === 'weekly') return addDays(date, 7 * dir);
  if (period === 'monthly') {
    const ny = m + dir < 1 ? y - 1 : m + dir > 12 ? y + 1 : y;
    const nm = m + dir < 1 ? 12 : m + dir > 12 ? 1 : m + dir;
    return `${ny}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
  }
  return `${y + dir}-${pad(m)}-${pad(Math.min(d, daysInMonth(y + dir, m)))}`;
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ’${date.slice(2, 4)}`;
const dayLabel = (date: string) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;

export function periodLabel(period: Period, r: Range): string {
  if (period === 'daily') return `${dayLabel(r.from)} ’${r.from.slice(2, 4)}`;
  if (period === 'weekly') return `${dayLabel(r.from)} – ${dayLabel(r.to)}`;
  if (period === 'monthly') return monthLabel(r.from);
  return r.from.slice(0, 4);
}

export interface Overview {
  period: Period;
  date: string;
  from: string;
  to: string;
  label: string;
  previousLabel: string;
  /** A date inside the previous / next period, for stepping in the UI. */
  prevDate: string;
  nextDate: string;
  out: number;
  in: number;
  previousOut: number;
  count: number;
  avgPerDay: number;
  /** Trend bars: per day (daily/weekly/monthly heatmap) or per month (yearly). */
  trend: { key: string; label: string; total: number }[];
  /** Blank cells before the first heatmap day so columns line up Monday..Sunday (monthly only). */
  leadingBlanks: number;
  cumulative: { current: number[]; previous: number[] } | null;
  categories: { categoryId: number; name: string; emoji: string; total: number; share: number }[];
}

interface Row {
  localDate: string;
  type: string;
  amount: number;
  categoryId: number | null;
}

export function overview(db: Db, period: Period, date: string, todayDate = jakartaToday()): Overview {
  const range = periodRange(period, date);
  const prevRange = periodRange(period, stepPeriod(period, date, -1));
  const pick = { localDate: transactions.localDate, type: transactions.type, amount: transactions.amount, categoryId: transactions.categoryId };
  const rows: Row[] = db
    .select(pick)
    .from(transactions)
    .where(and(eq(transactions.status, 'posted'), gte(transactions.localDate, prevRange.from), lte(transactions.localDate, range.to)))
    .all()
    .filter((r) => r.type !== 'transfer');

  const inRange = (r: Row, x: Range) => r.localDate >= x.from && r.localDate <= x.to;
  const current = rows.filter((r) => inRange(r, range));
  const previous = rows.filter((r) => inRange(r, prevRange));
  const sum = (xs: Row[], type: string) => xs.filter((r) => r.type === type).reduce((s, r) => s + r.amount, 0);
  const outRows = current.filter((r) => r.type === 'expense');

  const out = sum(current, 'expense');
  const total = daysBetween(range.from, range.to);
  const elapsed = todayDate < range.from ? total : Math.min(total, daysBetween(range.from, todayDate < range.to ? todayDate : range.to));

  // Trend
  let trend: Overview['trend'] = [];
  let leadingBlanks = 0;
  if (period === 'yearly') {
    const byMonth = new Map<string, number>();
    for (const r of outRows) byMonth.set(r.localDate.slice(0, 7), (byMonth.get(r.localDate.slice(0, 7)) ?? 0) + r.amount);
    trend = Array.from({ length: 12 }, (_, i) => {
      const key = `${range.from.slice(0, 4)}-${pad(i + 1)}`;
      return { key, label: MONTHS[i]!, total: byMonth.get(key) ?? 0 };
    });
  } else {
    const start = period === 'daily' ? addDays(date, -6) : range.from;
    const count = period === 'daily' ? 7 : total;
    const dayRows: Row[] = period === 'daily'
      ? db.select(pick).from(transactions)
        .where(and(eq(transactions.status, 'posted'), eq(transactions.type, 'expense'), gte(transactions.localDate, start), lte(transactions.localDate, date)))
        .all()
      : outRows;
    const totals = new Map<string, number>();
    for (const r of dayRows) totals.set(r.localDate, (totals.get(r.localDate) ?? 0) + r.amount);
    trend = Array.from({ length: count }, (_, i) => {
      const d = addDays(start, i);
      return { key: d, label: period === 'monthly' ? String(Number(d.slice(8, 10))) : dayLabel(d), total: totals.get(d) ?? 0 };
    });
    if (period === 'monthly') leadingBlanks = dayOfWeekMon0(range.from);
  }

  // Cumulative against the previous period (monthly / weekly)
  let cumulative: Overview['cumulative'] = null;
  if (period === 'monthly' || period === 'weekly') {
    const series = (rs: Row[], x: Range, upTo: number) => {
      const per = new Map<string, number>();
      for (const r of rs.filter((q) => q.type === 'expense' && inRange(q, x))) per.set(r.localDate, (per.get(r.localDate) ?? 0) + r.amount);
      let run = 0;
      return Array.from({ length: upTo }, (_, i) => (run += per.get(addDays(x.from, i)) ?? 0));
    };
    cumulative = {
      current: series(current, range, elapsed),
      previous: series(previous, prevRange, daysBetween(prevRange.from, prevRange.to)),
    };
  }

  // Categories
  const meta = new Map(db.select().from(categories).all().map((c) => [c.id, c]));
  const byCat = new Map<number, number>();
  for (const r of outRows) if (r.categoryId) byCat.set(r.categoryId, (byCat.get(r.categoryId) ?? 0) + r.amount);
  const cats = [...byCat]
    .map(([categoryId, t]) => ({ categoryId, name: meta.get(categoryId)?.name ?? 'Unknown', emoji: meta.get(categoryId)?.emoji ?? '\u{1F4E6}', total: t, share: out ? t / out : 0 }))
    .sort((a, b) => b.total - a.total);

  return {
    period,
    date,
    from: range.from,
    to: range.to,
    label: periodLabel(period, range),
    previousLabel: periodLabel(period, prevRange),
    prevDate: stepPeriod(period, date, -1),
    nextDate: stepPeriod(period, date, 1),
    out,
    in: sum(current, 'income'),
    previousOut: sum(previous, 'expense'),
    count: outRows.length,
    avgPerDay: elapsed ? Math.round(out / elapsed) : 0,
    trend,
    leadingBlanks,
    cumulative,
    categories: cats,
  };
}
