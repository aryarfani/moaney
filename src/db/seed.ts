import { count } from 'drizzle-orm';
import type { Db } from './client.js';
import { categories, wallets } from './schema.js';

const CATEGORIES = [
  ['My Food', '🍜'], ['Family Food', '🍚'], ['Family Bill', '🧾'], ['Household', '🏠'], ['Others', '📦'],
  ['Holiday', '🏖️'], ['Sandang', '👕'], ['Self Investment', '📚'], ['Hereafter', '🤲'], ['Healing', '🌿'],
  ['Kuliah', '🎓'], ['Gift', '🎁'], ['Others Debt', '🤝'],
] as const;

const INCOME = [['Salary', '💼'], ['Other income', '💰']] as const;

const WALLETS = [
  ['BCA', 'bank', '🏦'], ['Jago', 'bank', '🟠'], ['GoPay', 'ewallet', '🟢'], ['Cash', 'cash', '💵'],
  ['Owed to me', 'receivable', '🤝'], ['Before Moaney', 'history', '🕰️'],
] as const;

/** Idempotent: only seeds an empty database, so edits made in the app are never overwritten. */
export function seed(db: Db): void {
  db.transaction((tx) => {
    if ((tx.select({ n: count() }).from(categories).get()?.n ?? 0) === 0) {
      tx.insert(categories).values([
        ...CATEGORIES.map(([name, emoji], sort) => ({ name, emoji, kind: 'expense', sort })),
        ...INCOME.map(([name, emoji], i) => ({ name, emoji, kind: 'income', sort: 100 + i })),
      ]).run();
    }
    if ((tx.select({ n: count() }).from(wallets).get()?.n ?? 0) === 0) {
      tx.insert(wallets).values(WALLETS.map(([name, kind, emoji], sort) => ({ name, kind, emoji, sort }))).run();
    }
  });
}
