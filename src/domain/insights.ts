import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { categories, transactions, wallets } from '../db/schema.js';
import { addDays, sameDayLastMonth } from './time.js';
import { normaliseDescription } from './parse-entry.js';

export interface LogAgainChip {
  description: string;
  categoryId: number;
  walletId: number;
  amount: number;
  count: number;
}

/**
 * Most repeated expenses: description + category, usual (most common) amount,
 * wallet from the latest use. Cheap enough to compute on the fly for a single user.
 */
export function logAgainChips(db: Db, limit = 8, sinceDays = 365, todayDate = new Date().toISOString().slice(0, 10)): LogAgainChip[] {
  const since = addDays(todayDate, -sinceDays);
  const rows = db
    .select()
    .from(transactions)
    .where(and(eq(transactions.type, 'expense'), eq(transactions.status, 'posted'), gte(transactions.localDate, since)))
    .all();
  const history = new Set(db.select().from(wallets).where(eq(wallets.kind, 'history')).all().map((w) => w.id));

  const groups = new Map<string, { description: string; categoryId: number; amounts: Map<number, number>; last: (typeof rows)[number]; count: number }>();
  for (const t of rows) {
    if (!t.description || !t.categoryId) continue;
    const key = `${normaliseDescription(t.description)}|${t.categoryId}`;
    let g = groups.get(key);
    if (!g) {
      g = { description: t.description, categoryId: t.categoryId, amounts: new Map(), last: t, count: 0 };
      groups.set(key, g);
    }
    g.count++;
    g.amounts.set(t.amount, (g.amounts.get(t.amount) ?? 0) + 1);
    if (t.occurredAt > g.last.occurredAt) g.last = t;
  }
  return [...groups.values()]
    .filter((g) => g.count >= 2)
    .sort((a, b) => b.count - a.count || b.last.occurredAt.localeCompare(a.last.occurredAt))
    .slice(0, limit)
    .map((g) => {
      const usual = [...g.amounts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
      // A history wallet cannot be logged against; fall back to nothing here and let the client pick a default.
      const walletId = history.has(g.last.walletId) ? 0 : g.last.walletId;
      return { description: g.description, categoryId: g.categoryId, walletId, amount: usual, count: g.count };
    });
}

/** Learned description -> category map for typed entry. */
export function categoryByDescription(db: Db): Map<string, number> {
  const rows = db
    .select({ d: transactions.description, c: transactions.categoryId, n: sql<number>`count(*)` })
    .from(transactions)
    .where(and(eq(transactions.type, 'expense'), eq(transactions.status, 'posted')))
    .groupBy(transactions.description, transactions.categoryId)
    .all();
  const best = new Map<string, { c: number; n: number }>();
  for (const r of rows) {
    if (!r.d || !r.c) continue;
    const k = normaliseDescription(r.d);
    const cur = best.get(k);
    if (!cur || r.n > cur.n) best.set(k, { c: r.c, n: r.n });
  }
  return new Map([...best].map(([k, v]) => [k, v.c]));
}

function spentBetween(db: Db, from: string, to: string): { total: number; count: number } {
  const r = db
    .select({ total: sql<number>`coalesce(sum(${transactions.amount}), 0)`, count: sql<number>`count(*)` })
    .from(transactions)
    .where(and(eq(transactions.type, 'expense'), eq(transactions.status, 'posted'), gte(transactions.localDate, from), lte(transactions.localDate, to)))
    .get();
  return { total: r?.total ?? 0, count: r?.count ?? 0 };
}

export function homeSummary(db: Db, date: string) {
  const monthStart = `${date.slice(0, 7)}-01`;
  const prev = sameDayLastMonth(date);
  const prevStart = `${prev.slice(0, 7)}-01`;
  const today = spentBetween(db, date, date);
  const month = spentBetween(db, monthStart, date);
  const lastMonth = spentBetween(db, prevStart, prev);
  const income = db
    .select({ total: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
    .from(transactions)
    .where(and(eq(transactions.type, 'income'), eq(transactions.status, 'posted'), gte(transactions.localDate, monthStart), lte(transactions.localDate, date)))
    .get();
  const top = db
    .select({ categoryId: transactions.categoryId, name: categories.name, emoji: categories.emoji, total: sql<number>`sum(${transactions.amount})` })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(eq(transactions.type, 'expense'), eq(transactions.status, 'posted'), gte(transactions.localDate, monthStart), lte(transactions.localDate, date)))
    .groupBy(transactions.categoryId)
    .orderBy(sql`sum(${transactions.amount}) desc`)
    .limit(5)
    .all();
  return {
    date,
    today,
    month: { ...month, income: income?.total ?? 0 },
    sameDayLastMonth: { date: prev, ...lastMonth },
    topCategories: top,
  };
}
