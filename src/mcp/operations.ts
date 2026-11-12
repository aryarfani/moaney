import { eq, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  auditEvents,
  bills,
  categories,
  goals,
  holdings,
  notifications,
  rules,
  transactions,
  wallets,
} from '../db/schema.js';
import {
  createTransaction,
  LedgerError,
  updateTransaction,
  voidTransaction,
  type TransactionRow,
} from '../domain/ledger.js';
import {
  addTrade,
  archiveHolding,
  createHolding,
  parseUnits,
  setPrice,
  updateHolding,
} from '../domain/investments.js';
import {
  confirmEdited,
  confirmNotification,
  dismissNotification,
  keepBoth,
  keepOne,
} from '../domain/capture.js';
import { payBill } from '../domain/plan.js';
import type { Principal } from './oauth.js';
import { entrySchema, toMinor, type Operation } from './schemas.js';

export function ledgerEntry(entry: ReturnType<typeof entrySchema.parse>) {
  const { amountRupiah, ...rest } = entry;
  return { ...rest, amount: toMinor(amountRupiah), source: 'mcp' as const };
}
function mustWallet(db: Db, id: number | null | undefined) {
  if (id == null) return;
  const row = db.select().from(wallets).where(eq(wallets.id, id)).get();
  if (!row || row.archived) throw new LedgerError('Wallet not found or archived', 404);
  return row;
}
function mustCategory(db: Db, id: number | null | undefined, kind?: string) {
  if (id == null) return;
  const row = db.select().from(categories).where(eq(categories.id, id)).get();
  if (!row || row.archived) throw new LedgerError('Category not found or archived', 404);
  if (kind && row.kind !== kind) throw new LedgerError('Category kind does not match');
  return row;
}
function ensure<T>(row: T | undefined, name: string): T {
  if (!row) throw new LedgerError(`${name} not found`, 404);
  return row;
}

function usableEntry(db: Db, entry: TransactionRow) {
  mustWallet(db, entry.walletId);
  mustWallet(db, entry.toWalletId);
  mustCategory(db, entry.categoryId, entry.type);
  return entry;
}

function record(db: Db, family: string, id: number) {
  switch (family) {
    case 'wallet':
      return db.select().from(wallets).where(eq(wallets.id, id)).get();
    case 'category':
      return db.select().from(categories).where(eq(categories.id, id)).get();
    case 'goal':
      return db.select().from(goals).where(eq(goals.id, id)).get();
    case 'bill':
      return db.select().from(bills).where(eq(bills.id, id)).get();
    case 'holding':
      return db.select().from(holdings).where(eq(holdings.id, id)).get();
    case 'capture':
      return db.select().from(notifications).where(eq(notifications.id, id)).get();
    case 'rule':
      return db.select().from(rules).where(eq(rules.id, id)).get();
  }
}

export function executeOperation(db: Db, p: Principal, o: Operation): unknown {
  const actor = `mcp:${p.clientId}`;
  const family = o.op.split('.')[0]!;
  const before = 'id' in o ? record(db, family, o.id) : undefined;
  let result: unknown;
  switch (o.op) {
    case 'transaction.create': {
      const e = ledgerEntry(o.entry);
      mustWallet(db, e.walletId);
      mustWallet(db, e.toWalletId);
      mustCategory(db, e.categoryId, e.type);
      if (
        e.externalId &&
        db.select().from(transactions).where(eq(transactions.externalId, e.externalId)).get()
      )
        throw new LedgerError('Duplicate external source ID', 409);
      result = createTransaction(db, e, actor);
      break;
    }
    case 'transaction.update': {
      const { amountRupiah, ...rest } = o.patch;
      result = usableEntry(
        db,
        updateTransaction(
          db,
          o.id,
          { ...rest, ...(amountRupiah !== undefined ? { amount: toMinor(amountRupiah) } : {}) },
          actor,
        ),
      );
      break;
    }
    case 'transaction.void':
      result = voidTransaction(db, o.id, actor, o.reason);
      break;
    case 'wallet.create': {
      const { openingBalanceRupiah, ...rest } = o.wallet;
      result = db
        .insert(wallets)
        .values({ ...rest, openingBalance: toMinor(openingBalanceRupiah) })
        .returning()
        .get();
      break;
    }
    case 'wallet.update': {
      ensure(db.select().from(wallets).where(eq(wallets.id, o.id)).get(), 'Wallet');
      const { openingBalanceRupiah, ...rest } = o.patch;
      if (
        rest.kind &&
        db
          .select()
          .from(transactions)
          .where(or(eq(transactions.walletId, o.id), eq(transactions.toWalletId, o.id)))
          .get()
      )
        throw new LedgerError('Cannot change kind of a wallet with transactions');
      result = db
        .update(wallets)
        .set({
          ...rest,
          ...(openingBalanceRupiah !== undefined ? { openingBalance: toMinor(openingBalanceRupiah) } : {}),
        })
        .where(eq(wallets.id, o.id))
        .returning()
        .get();
      break;
    }
    case 'category.create': {
      const { monthlyBudgetRupiah, ...rest } = o.category;
      result = db
        .insert(categories)
        .values({ ...rest, monthlyBudget: monthlyBudgetRupiah == null ? null : toMinor(monthlyBudgetRupiah) })
        .returning()
        .get();
      break;
    }
    case 'category.update': {
      ensure(db.select().from(categories).where(eq(categories.id, o.id)).get(), 'Category');
      const { monthlyBudgetRupiah, ...rest } = o.patch;
      if (rest.kind && db.select().from(transactions).where(eq(transactions.categoryId, o.id)).get())
        throw new LedgerError('Cannot change kind of a category with transactions');
      result = db
        .update(categories)
        .set({
          ...rest,
          ...(monthlyBudgetRupiah !== undefined
            ? { monthlyBudget: monthlyBudgetRupiah === null ? null : toMinor(monthlyBudgetRupiah) }
            : {}),
        })
        .where(eq(categories.id, o.id))
        .returning()
        .get();
      break;
    }
    case 'goal.create': {
      const { targetRupiah, savedRupiah, ...rest } = o.goal;
      mustWallet(db, rest.walletId);
      result = db
        .insert(goals)
        .values({ ...rest, target: toMinor(targetRupiah), saved: toMinor(savedRupiah) })
        .returning()
        .get();
      break;
    }
    case 'goal.update': {
      ensure(db.select().from(goals).where(eq(goals.id, o.id)).get(), 'Goal');
      const { targetRupiah, savedRupiah, ...rest } = o.patch;
      mustWallet(db, rest.walletId);
      result = db
        .update(goals)
        .set({
          ...rest,
          ...(targetRupiah !== undefined ? { target: toMinor(targetRupiah) } : {}),
          ...(savedRupiah !== undefined ? { saved: toMinor(savedRupiah) } : {}),
        })
        .where(eq(goals.id, o.id))
        .returning()
        .get();
      break;
    }
    case 'goal.add': {
      const old = ensure(db.select().from(goals).where(eq(goals.id, o.id)).get(), 'Goal'),
        saved = old.saved + toMinor(o.amountRupiah);
      if (old.archived) throw new LedgerError('Goal is archived');
      if (!Number.isSafeInteger(saved)) throw new LedgerError('Amount too large');
      result = db.update(goals).set({ saved }).where(eq(goals.id, o.id)).returning().get();
      break;
    }
    case 'bill.create': {
      const { amountRupiah, ...rest } = o.bill;
      mustWallet(db, rest.walletId);
      mustCategory(db, rest.categoryId, 'expense');
      result = db
        .insert(bills)
        .values({ ...rest, amount: toMinor(amountRupiah) })
        .returning()
        .get();
      break;
    }
    case 'bill.update': {
      ensure(db.select().from(bills).where(eq(bills.id, o.id)).get(), 'Bill');
      const { amountRupiah, ...rest } = o.patch;
      mustWallet(db, rest.walletId);
      mustCategory(db, rest.categoryId, 'expense');
      result = db
        .update(bills)
        .set({ ...rest, ...(amountRupiah !== undefined ? { amount: toMinor(amountRupiah) } : {}) })
        .where(eq(bills.id, o.id))
        .returning()
        .get();
      break;
    }
    case 'bill.pay': {
      const bill = ensure(db.select().from(bills).where(eq(bills.id, o.id)).get(), 'Bill');
      if (!bill.active) throw new LedgerError('Bill is inactive');
      mustWallet(db, bill.walletId);
      mustCategory(db, bill.categoryId, 'expense');
      result = payBill(db, o.id, o.paidOn, actor, 'mcp');
      break;
    }
    case 'holding.create': {
      const { priceRupiah, first, ...rest } = o.holding;
      result = createHolding(db, {
        ...rest,
        price: priceRupiah == null ? null : toMinor(priceRupiah),
        first: first
          ? { date: first.date, unitsE4: parseUnits(first.units), amount: toMinor(first.amountRupiah) }
          : null,
      });
      break;
    }
    case 'holding.update':
      result = updateHolding(db, o.id, o.patch);
      break;
    case 'holding.archive':
      result = archiveHolding(db, o.id);
      break;
    case 'holding.trade': {
      const holding = ensure(db.select().from(holdings).where(eq(holdings.id, o.id)).get(), 'Holding');
      if (holding.archived) throw new LedgerError('Holding is archived');
      result = addTrade(db, o.id, {
        kind: o.trade.kind,
        date: o.trade.date,
        unitsE4: o.trade.kind === 'income' ? 0 : parseUnits(o.trade.units),
        amount: toMinor(o.trade.amountRupiah),
      });
      break;
    }
    case 'holding.price':
      result = setPrice(db, o.id, toMinor(o.priceRupiah), o.date);
      break;
    case 'capture.confirm': {
      const { amountRupiah, ...rest } = o.overrides;
      mustWallet(db, rest.walletId);
      mustCategory(db, rest.categoryId);
      result = usableEntry(
        db,
        confirmNotification(
          db,
          o.id,
          { ...rest, ...(amountRupiah !== undefined ? { amount: toMinor(amountRupiah) } : {}) },
          actor,
        ),
      );
      break;
    }
    case 'capture.edit_confirm': {
      const e = ledgerEntry(o.entry);
      mustWallet(db, e.walletId);
      mustWallet(db, e.toWalletId);
      mustCategory(db, e.categoryId, e.type);
      result = usableEntry(db, confirmEdited(db, o.id, e, actor));
      break;
    }
    case 'capture.dismiss':
      dismissNotification(db, o.id);
      result = { id: o.id, status: 'dismissed' };
      break;
    case 'capture.keep_one': {
      const kept = keepOne(db, o.id, actor);
      result = kept ? usableEntry(db, kept) : null;
      break;
    }
    case 'capture.keep_both':
      keepBoth(db, o.id);
      result = { id: o.id, status: 'pending' };
      break;
    case 'rule.create':
      mustCategory(db, o.rule.categoryId);
      result = db.insert(rules).values(o.rule).returning().get();
      break;
    case 'rule.update': {
      ensure(db.select().from(rules).where(eq(rules.id, o.id)).get(), 'Rule');
      mustCategory(db, o.patch.categoryId);
      result = db.update(rules).set(o.patch).where(eq(rules.id, o.id)).returning().get();
      break;
    }
  }
  if (family !== 'transaction') {
    const entityId =
      'id' in o ? o.id : result && typeof result === 'object' && 'id' in result ? Number(result.id) : null;
    const after = entityId ? record(db, family, entityId) : result;
    db.insert(auditEvents)
      .values({
        actor,
        action: o.op,
        entity: family === 'capture' ? 'notification' : family,
        entityId,
        oldValue: before ? JSON.stringify(before) : null,
        newValue: JSON.stringify(after ?? null),
      })
      .run();
  }
  return result;
}
