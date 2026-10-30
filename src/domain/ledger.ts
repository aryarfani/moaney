import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditEvents, categories, journalLines, transactions, wallets } from '../db/schema.js';
import type { TransactionInput, TransactionPatch } from '../../shared/schemas.js';
import { normaliseOccurredAt } from './time.js';

export class LedgerError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type TransactionRow = typeof transactions.$inferSelect;

interface Normalised {
  type: string;
  amount: number;
  walletId: number;
  toWalletId: number | null;
  categoryId: number | null;
  description: string;
  note: string | null;
  occurredAt: string;
  source: string;
  externalId: string | null;
}

const NOW_SQL = sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))`;

function audit(tx: Tx, actor: string, action: string, id: number, oldValue: unknown, newValue: unknown, reason?: string) {
  tx.insert(auditEvents).values({
    actor,
    action,
    entity: 'transaction',
    entityId: id,
    oldValue: oldValue ? JSON.stringify(oldValue) : null,
    newValue: newValue ? JSON.stringify(newValue) : null,
    reason: reason ?? null,
  }).run();
}

function validate(tx: Tx, n: Normalised): void {
  const wallet = tx.select().from(wallets).where(eq(wallets.id, n.walletId)).get();
  if (!wallet) throw new LedgerError('Wallet not found', 404);
  if (n.type === 'transfer') {
    if (!n.toWalletId) throw new LedgerError('A transfer needs a destination wallet');
    if (n.toWalletId === n.walletId) throw new LedgerError('A transfer needs two different wallets');
    const to = tx.select().from(wallets).where(eq(wallets.id, n.toWalletId)).get();
    if (!to) throw new LedgerError('Destination wallet not found', 404);
    if (to.kind === 'history' || wallet.kind === 'history') {
      throw new LedgerError('History wallets cannot take part in transfers');
    }
    if (n.categoryId) throw new LedgerError('Transfers have no category');
    return;
  }
  if (n.toWalletId) throw new LedgerError('Only transfers have a destination wallet');
  if (!n.categoryId) throw new LedgerError('Pick a category');
  const cat = tx.select().from(categories).where(eq(categories.id, n.categoryId)).get();
  if (!cat) throw new LedgerError('Category not found', 404);
  if (cat.kind !== n.type) throw new LedgerError(`Category "${cat.name}" is for ${cat.kind}, not ${n.type}`);
}

/** Debit/credit lines per spec 8.3. Always balanced. */
export function buildLines(n: Pick<Normalised, 'type' | 'amount' | 'walletId' | 'toWalletId' | 'categoryId'>) {
  const a = n.amount;
  if (n.type === 'expense') {
    return [
      { accountType: 'category', accountId: n.categoryId!, debit: a, credit: 0 },
      { accountType: 'wallet', accountId: n.walletId, debit: 0, credit: a },
    ];
  }
  if (n.type === 'income') {
    return [
      { accountType: 'wallet', accountId: n.walletId, debit: a, credit: 0 },
      { accountType: 'category', accountId: n.categoryId!, debit: 0, credit: a },
    ];
  }
  return [
    { accountType: 'wallet', accountId: n.toWalletId!, debit: a, credit: 0 },
    { accountType: 'wallet', accountId: n.walletId, debit: 0, credit: a },
  ];
}

function writeLines(tx: Tx, id: number, n: Normalised): void {
  tx.delete(journalLines).where(eq(journalLines.transactionId, id)).run();
  const lines = buildLines(n);
  const sum = (k: 'debit' | 'credit') => lines.reduce((s, l) => s + l[k], 0);
  if (sum('debit') !== sum('credit')) throw new LedgerError('Unbalanced journal', 500);
  tx.insert(journalLines).values(lines.map((l) => ({ ...l, transactionId: id }))).run();
}

function normalise(input: TransactionInput): Normalised {
  let occurredAt: string;
  try {
    occurredAt = normaliseOccurredAt(input.occurredAt);
  } catch (e) {
    throw new LedgerError((e as Error).message);
  }
  return {
    type: input.type,
    amount: input.amount,
    walletId: input.walletId,
    toWalletId: input.type === 'transfer' ? input.toWalletId ?? null : null,
    categoryId: input.type === 'transfer' ? null : input.categoryId ?? null,
    description: input.description ?? '',
    note: input.note ?? null,
    occurredAt,
    source: input.source ?? 'manual',
    externalId: input.externalId ?? null,
  };
}

export function insertTransaction(tx: Tx, input: TransactionInput, actor: string): TransactionRow {
  const n = normalise(input);
  validate(tx, n);
  const row = tx.insert(transactions).values({ ...n, localDate: n.occurredAt.slice(0, 10) }).returning().get();
  writeLines(tx, row.id, n);
  audit(tx, actor, 'create', row.id, null, row);
  return row;
}

export function createTransaction(db: Db, input: TransactionInput, actor = 'owner'): TransactionRow {
  return db.transaction((tx) => insertTransaction(tx, input, actor));
}

export function updateTransaction(db: Db, id: number, patch: TransactionPatch, actor = 'owner'): TransactionRow {
  return db.transaction((tx) => {
    const old = tx.select().from(transactions).where(eq(transactions.id, id)).get();
    if (!old) throw new LedgerError('Transaction not found', 404);
    if (old.status === 'void') throw new LedgerError('A voided transaction cannot be edited', 409);
    const merged = normalise({
      type: (patch.type ?? old.type) as TransactionInput['type'],
      amount: patch.amount ?? old.amount,
      walletId: patch.walletId ?? old.walletId,
      toWalletId: patch.toWalletId === undefined ? old.toWalletId : patch.toWalletId,
      categoryId: patch.categoryId === undefined ? old.categoryId : patch.categoryId,
      description: patch.description ?? old.description,
      note: patch.note === undefined ? old.note : patch.note,
      occurredAt: patch.occurredAt ?? old.occurredAt,
      source: old.source as TransactionInput['source'],
      externalId: old.externalId,
    });
    validate(tx, merged);
    const row = tx
      .update(transactions)
      .set({ ...merged, localDate: merged.occurredAt.slice(0, 10), updatedAt: NOW_SQL })
      .where(eq(transactions.id, id))
      .returning()
      .get();
    writeLines(tx, id, merged); // regenerate, never patch lines in place (spec 8.4)
    audit(tx, actor, 'update', id, old, row);
    return row;
  });
}

export function voidTransaction(db: Db, id: number, actor = 'owner', reason?: string): TransactionRow {
  return db.transaction((tx) => {
    const old = tx.select().from(transactions).where(eq(transactions.id, id)).get();
    if (!old) throw new LedgerError('Transaction not found', 404);
    if (old.status === 'void') return old;
    const row = tx.update(transactions).set({ status: 'void', updatedAt: NOW_SQL }).where(eq(transactions.id, id)).returning().get();
    audit(tx, actor, 'void', id, old, row, reason);
    return row;
  });
}

/** Ledger balance = opening balance + sum(debit - credit) over posted journal lines. */
export function walletBalances(db: Db): Map<number, number> {
  const rows = db
    .select({ id: journalLines.accountId, net: sql<number>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)` })
    .from(journalLines)
    .innerJoin(transactions, eq(transactions.id, journalLines.transactionId))
    .where(and(eq(journalLines.accountType, 'wallet'), eq(transactions.status, 'posted')))
    .groupBy(journalLines.accountId)
    .all();
  const net = new Map(rows.map((r) => [r.id, r.net]));
  const out = new Map<number, number>();
  for (const w of db.select().from(wallets).all()) out.set(w.id, w.openingBalance + (net.get(w.id) ?? 0));
  return out;
}
