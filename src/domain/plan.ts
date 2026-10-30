import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bills, categories, goals, rules, settings, transactions } from '../db/schema.js';
import { createTransaction, LedgerError } from './ledger.js';
import { today } from './time.js';

export const SETTING_KEYS = ['bills.autoMatch', 'capture.retentionDays'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
const DEFAULTS: Record<SettingKey, string> = { 'bills.autoMatch': 'true', 'capture.retentionDays': '30' };

export function getSetting(db: Db, key: SettingKey): string {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? DEFAULTS[key];
}

export function setSetting(db: Db, key: SettingKey, value: string): void {
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Same day next month(s), clamped to the target month's length (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, dim(ny, nm))).padStart(2, '0')}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000);
}

/** Minor units to set aside per month to reach the target by dueDate. Null without a due date or when done. */
export function monthlyNeeded(target: number, saved: number, dueDate: string | null, todayDate = today()): number | null {
  if (!dueDate || saved >= target) return null;
  const [y1, m1] = todayDate.split('-').map(Number) as [number, number];
  const [y2, m2] = dueDate.split('-').map(Number) as [number, number];
  const months = Math.max(1, (y2 - y1) * 12 + (m2 - m1));
  return Math.ceil((target - saved) / months);
}

export function categoriesOverview(db: Db, month: string) {
  const from = `${month}-01`;
  const to = `${month}-${String(dim(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`;
  const spent = new Map(
    db
      .select({ id: transactions.categoryId, total: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions)
      .where(and(eq(transactions.status, 'posted'), gte(transactions.localDate, from), lte(transactions.localDate, to)))
      .groupBy(transactions.categoryId)
      .all()
      .map((r) => [r.id, r.total]),
  );
  return db.select().from(categories).orderBy(categories.sort, categories.id).all().map((c) => ({
    id: c.id,
    spent: spent.get(c.id) ?? 0,
    budget: c.monthlyBudget ?? null,
  }));
}

export function payBill(db: Db, id: number, paidOn = today()) {
  return db.transaction((tx) => {
    const bill = tx.select().from(bills).where(eq(bills.id, id)).get();
    if (!bill) throw new LedgerError('Bill not found', 404);
    const txn = createTransaction(tx as unknown as Db, {
      type: 'expense', amount: bill.amount, walletId: bill.walletId, categoryId: bill.categoryId,
      description: bill.name, occurredAt: paidOn, source: 'manual',
    });
    const updated = tx.update(bills).set({ nextDue: addMonths(bill.nextDue, 1) }).where(eq(bills.id, id)).returning().get();
    return { bill: updated, transaction: txn };
  });
}

export function settingsSummary(db: Db, todayDate = today()) {
  const activeGoals = db.select().from(goals).where(eq(goals.archived, false)).all();
  const activeBills = db.select().from(bills).where(eq(bills.active, true)).all().sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  const cats = db.select().from(categories).where(eq(categories.archived, false)).all();
  const suggested = db.select().from(rules).where(eq(rules.status, 'suggested')).all().length;
  return {
    categories: cats.length,
    goals: { count: activeGoals.length, saved: activeGoals.reduce((s, g) => s + g.saved, 0) },
    bills: { count: activeBills.length, nextInDays: activeBills[0] ? daysBetween(todayDate, activeBills[0].nextDue) : null },
    suggestedRules: suggested,
  };
}
