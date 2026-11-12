import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { freshDb } from './helpers.js';
import { previewChanges, commitChanges } from '../src/mcp/changes.js';
import {
  categories,
  transactions,
  journalLines,
  auditEvents,
  goals,
  bills,
  notifications,
} from '../src/db/schema.js';
import { createTransaction } from '../src/domain/ledger.js';
import type { Principal } from '../src/mcp/oauth.js';
import { openDb } from '../src/db/client.js';

const owner: Principal = {
  clientId: 'client-a',
  grantId: 'grant-a',
  scopes: ['moaney:read', 'moaney:write'],
};
const other: Principal = { ...owner, grantId: 'grant-b', clientId: 'client-b' };
const entry = (t: ReturnType<typeof freshDb>, externalId = 'shopee-1') => ({
  op: 'transaction.create',
  entry: {
    type: 'expense',
    amountRupiah: '68600',
    walletId: t.w('Cash'),
    categoryId: t.c('My Food'),
    occurredAt: '2026-11-09T22:04:00+07:00',
    description: 'Shopee dimsum',
    externalId,
  },
});
const apply = (t: ReturnType<typeof freshDb>, operations: unknown[]) => {
  const d = previewChanges(t, owner, { operations });
  return commitChanges(t, owner, d.draftId, d.digest);
};

describe('MCP reviewed changes', () => {
  it('rolls back preview journal and audit effects, converts rupiah exactly and commits once', () => {
    const t = freshDb();
    const draft = previewChanges(t, owner, { operations: [entry(t)] });
    expect(t.db.select().from(transactions).all()).toHaveLength(0);
    expect(t.db.select().from(journalLines).all()).toHaveLength(0);
    expect(t.db.select().from(auditEvents).all()).toHaveLength(0);
    expect(draft.results[0]).toMatchObject({ amount: 6860000, source: 'mcp', localDate: '2026-11-09' });
    const receipt = commitChanges(t, owner, draft.draftId, draft.digest);
    expect(receipt.results[0]).toMatchObject({ amount: 6860000, source: 'mcp' });
    expect(t.db.select().from(journalLines).all()).toMatchObject([
      { debit: 6860000, credit: 0 },
      { debit: 0, credit: 6860000 },
    ]);
    expect(commitChanges(t, owner, draft.draftId, draft.digest)).toEqual(receipt);
    expect(t.db.select().from(transactions).all()).toHaveLength(1);
    expect(
      t.db
        .select()
        .from(auditEvents)
        .all()
        .some((e) => e.actor === 'mcp:client-a'),
    ).toBe(true);
  });

  it('rejects unapproved digests, another client and a read-only grant', () => {
    const t = freshDb(),
      d = previewChanges(t, owner, { operations: [entry(t)] });
    expect(() => commitChanges(t, owner, d.draftId, 'wrong')).toThrow(/confirmation/i);
    expect(() => commitChanges(t, other, d.draftId, d.digest)).toThrow(/draft/i);
    expect(() =>
      previewChanges(t, { ...owner, scopes: ['moaney:read'] }, { operations: [entry(t)] }),
    ).toThrow(/scope/i);
    expect(t.db.select().from(transactions).all()).toHaveLength(0);
  });

  it('rejects stale and expired drafts before applying anything', () => {
    const t = freshDb(),
      d = previewChanges(t, owner, { operations: [entry(t)] });
    createTransaction(t.db, {
      type: 'expense',
      amount: 100,
      walletId: t.w('Cash'),
      categoryId: t.c('My Food'),
      source: 'manual',
      description: 'Concurrent edit',
    });
    expect(() => commitChanges(t, owner, d.draftId, d.digest)).toThrow(/changed/i);
    const newer = previewChanges(t, owner, { operations: [entry(t)] });
    t.raw.prepare('update mcp_records set expires_at=0 where key=?').run(`draft:${newer.draftId}`);
    expect(() => commitChanges(t, owner, newer.draftId, newer.digest)).toThrow(/expired|draft/i);
    expect(t.db.select().from(transactions).all()).toHaveLength(1);
  });

  it('rejects duplicate source IDs across batches and within an atomic batch', () => {
    const t = freshDb();
    expect(() => previewChanges(t, owner, { operations: [entry(t), entry(t)] })).toThrow(/duplicate/i);
    expect(t.db.select().from(transactions).all()).toHaveLength(0);
    apply(t, [entry(t)]);
    expect(() => previewChanges(t, owner, { operations: [entry(t)] })).toThrow(/duplicate/i);
  });

  it('rolls back a batch when a later operation is invalid', () => {
    const t = freshDb();
    const invalid = entry(t, 'bad');
    invalid.entry.walletId = 9999;
    expect(() => previewChanges(t, owner, { operations: [entry(t), invalid] })).toThrow(/wallet/i);
    expect(t.db.select().from(transactions).all()).toHaveLength(0);
    expect(t.db.select().from(auditEvents).all()).toHaveLength(0);
  });

  it('records transfers, updates and voids using the real ledger', () => {
    const t = freshDb();
    const made = apply(t, [entry(t)]).results[0] as { id: number };
    apply(t, [
      {
        op: 'transaction.update',
        id: made.id,
        patch: { amountRupiah: '11400', categoryId: t.c('Household') },
      },
    ]);
    expect(t.db.select().from(transactions).get()).toMatchObject({
      amount: 1140000,
      categoryId: t.c('Household'),
    });
    apply(t, [
      {
        op: 'transaction.create',
        entry: {
          type: 'transfer',
          amountRupiah: '123.45',
          walletId: t.w('Cash'),
          toWalletId: t.w('BCA'),
          occurredAt: '2026-11-12',
          description: 'Recorded transfer',
        },
      },
    ]);
    apply(t, [{ op: 'transaction.void', id: made.id, reason: 'Duplicate purchase' }]);
    expect(t.db.select().from(transactions).where(eq(transactions.id, made.id)).get()?.status).toBe('void');
    const move = t.db
      .select()
      .from(transactions)
      .all()
      .find((x) => x.type === 'transfer');
    expect(move).toMatchObject({ amount: 12345, categoryId: null });
  });

  it('manages categories, budgets, wallets, goals and bills with validated references', () => {
    const t = freshDb();
    const results = apply(t, [
      { op: 'category.create', category: { name: 'Health', monthlyBudgetRupiah: '500000' } },
      { op: 'wallet.create', wallet: { name: 'ShopeePay', kind: 'ewallet', openingBalanceRupiah: '100000' } },
      {
        op: 'goal.create',
        goal: { name: 'Laptop', targetRupiah: '10000000', savedRupiah: '0', walletId: t.w('Cash') },
      },
      {
        op: 'bill.create',
        bill: {
          name: 'Internet',
          amountRupiah: '127000',
          walletId: t.w('Cash'),
          categoryId: t.c('Household'),
          nextDue: '2026-11-12',
        },
      },
    ]).results as { id: number }[];
    expect(t.db.select().from(categories).where(eq(categories.id, results[0]!.id)).get()?.monthlyBudget).toBe(
      50000000,
    );
    apply(t, [
      { op: 'category.update', id: results[0]!.id, patch: { monthlyBudgetRupiah: '400000' } },
      { op: 'wallet.update', id: results[1]!.id, patch: { name: 'Shopee Pay' } },
      { op: 'goal.add', id: results[2]!.id, amountRupiah: '250000' },
      { op: 'bill.pay', id: results[3]!.id, paidOn: '2026-11-12' },
    ]);
    expect(t.db.select().from(goals).get()?.saved).toBe(25000000);
    expect(t.db.select().from(bills).get()?.nextDue).toBe('2026-12-12');
    expect(t.db.select().from(transactions).get()?.amount).toBe(12700000);
    apply(t, [
      { op: 'goal.update', id: results[2]!.id, patch: { archived: true } },
      { op: 'bill.update', id: results[3]!.id, patch: { active: false } },
    ]);
    expect(() =>
      previewChanges(t, owner, {
        operations: [{ op: 'goal.create', goal: { name: 'Bad', targetRupiah: '1', walletId: 999 } }],
      }),
    ).toThrow(/wallet/i);
  });

  it('records investment holdings, trades, prices and archives without moving real funds', () => {
    const t = freshDb();
    const h = apply(t, [
      { op: 'holding.create', holding: { symbol: 'TEST', name: 'Test asset', kind: 'fund' } },
    ]).results[0] as { id: number };
    apply(t, [
      {
        op: 'holding.trade',
        id: h.id,
        trade: { kind: 'buy', date: '2026-11-01', units: '2.5', amountRupiah: '1000' },
      },
      { op: 'holding.price', id: h.id, priceRupiah: '500', date: '2026-11-12' },
    ]);
    const receipt = apply(t, [
      { op: 'holding.update', id: h.id, patch: { name: 'Updated asset' } },
      { op: 'holding.archive', id: h.id },
    ]);
    expect(receipt.results[1]).toMatchObject({ archived: true, unitsE4: 25000, cost: 100000, price: 50000 });
    expect(t.db.select().from(transactions).all()).toHaveLength(0);
  });

  it('confirms and dismisses captured payments and manages categorization rules', () => {
    const t = freshDb();
    const n = t.db
      .insert(notifications)
      .values({
        app: 'gopay',
        text: 'Test payment',
        receivedAt: '2026-11-12T10:00:00+07:00',
        kind: 'new_payment',
        direction: 'out',
        amount: 123000,
        counterpart: 'Merchant',
        walletId: t.w('GoPay'),
        categoryId: t.c('My Food'),
      })
      .returning()
      .get();
    apply(t, [{ op: 'capture.confirm', id: n.id, overrides: { categoryId: t.c('Household') } }]);
    expect(t.db.select().from(transactions).get()).toMatchObject({
      amount: 123000,
      categoryId: t.c('Household'),
    });
    expect(t.db.select().from(notifications).get()?.status).toBe('confirmed');
    const second = t.db
      .insert(notifications)
      .values({ app: 'gopay', text: 'Ignore', receivedAt: '2026-11-12T11:00:00+07:00' })
      .returning()
      .get();
    apply(t, [
      { op: 'capture.dismiss', id: second.id },
      {
        op: 'rule.create',
        rule: { pattern: 'another merchant', categoryId: t.c('Household'), status: 'active' },
      },
    ]);
    expect(t.db.select().from(notifications).where(eq(notifications.id, second.id)).get()?.status).toBe(
      'dismissed',
    );
  });

  it('rejects unsafe money, invalid calendar dates, oversized batches and unknown properties', () => {
    const t = freshDb();
    for (const amountRupiah of ['1.001', '1,000', '0', '-1', '9007199254740992']) {
      const e = entry(t);
      e.entry.amountRupiah = amountRupiah;
      expect(() => previewChanges(t, owner, { operations: [e] })).toThrow();
    }
    const e = entry(t);
    e.entry.occurredAt = '2026-02-30';
    expect(() => previewChanges(t, owner, { operations: [e] })).toThrow();
    expect(() =>
      previewChanges(t, owner, { operations: Array.from({ length: 101 }, () => entry(t)) }),
    ).toThrow();
    expect(() =>
      previewChanges(t, owner, { operations: [{ ...entry(t), sql: 'delete from transactions' }] }),
    ).toThrow();
  });

  it('preserves omitted fields when updating existing records', () => {
    const t = freshDb();
    const tx = apply(t, [entry(t)]).results[0] as { id: number };
    const result = apply(t, [
      { op: 'goal.create', goal: { name: 'Goal', targetRupiah: '100', savedRupiah: '25' } },
      { op: 'holding.create', holding: { symbol: 'T', name: 'Existing name', kind: 'fund' } },
      { op: 'category.create', category: { name: 'Side income', kind: 'income', emoji: 'I' } },
    ]).results as { id: number }[];
    apply(t, [
      { op: 'transaction.update', id: tx.id, patch: { amountRupiah: '1' } },
      { op: 'goal.update', id: result[0]!.id, patch: { archived: true } },
      { op: 'holding.update', id: result[1]!.id, patch: { note: 'New note' } },
      { op: 'category.update', id: result[2]!.id, patch: { monthlyBudgetRupiah: '10' } },
    ]);
    expect(t.db.select().from(transactions).get()?.description).toBe('Shopee dimsum');
    expect(t.db.select().from(goals).get()?.saved).toBe(2500);
    expect(t.raw.prepare('select name from holdings').get()).toEqual({ name: 'Existing name' });
    expect(t.db.select().from(categories).where(eq(categories.id, result[2]!.id)).get()).toMatchObject({
      kind: 'income',
      emoji: 'I',
    });
  });

  it('records before and after values and MCP identity for management, bills and captures', () => {
    const t = freshDb();
    apply(t, [{ op: 'category.update', id: t.c('Household'), patch: { monthlyBudgetRupiah: '123' } }]);
    const audit = t.db.select().from(auditEvents).where(eq(auditEvents.entity, 'category')).get()!;
    expect(audit.actor).toBe('mcp:client-a');
    expect(JSON.parse(audit.oldValue!)).toMatchObject({ name: 'Household' });
    expect(JSON.parse(audit.newValue!)).toMatchObject({ monthlyBudget: 12300 });
    const bill = apply(t, [
      {
        op: 'bill.create',
        bill: {
          name: 'Test',
          amountRupiah: '100',
          walletId: t.w('Cash'),
          categoryId: t.c('Household'),
          nextDue: '2026-11-12',
        },
      },
    ]).results[0] as { id: number };
    apply(t, [{ op: 'bill.pay', id: bill.id, paidOn: '2026-11-12' }]);
    const paid = t.db.select().from(transactions).get()!;
    expect(paid.source).toBe('mcp');
    expect(
      t.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.entity, 'transaction'), eq(auditEvents.entityId, paid.id)))
        .get()?.actor,
    ).toBe('mcp:client-a');
  });

  it('does not change a wallet kind referenced as a transfer destination', () => {
    const t = freshDb();
    apply(t, [
      {
        op: 'transaction.create',
        entry: {
          type: 'transfer',
          amountRupiah: '1',
          walletId: t.w('Cash'),
          toWalletId: t.w('BCA'),
          occurredAt: '2026-11-12',
        },
      },
    ]);
    expect(() =>
      previewChanges(t, owner, {
        operations: [{ op: 'wallet.update', id: t.w('BCA'), patch: { kind: 'history' } }],
      }),
    ).toThrow(/kind/i);
  });

  it('rejects trades on an archived holding', () => {
    const t = freshDb();
    const made = apply(t, [{ op: 'holding.create', holding: { symbol: 'ARCHIVED', kind: 'fund' } }])
      .results[0] as { id: number };
    apply(t, [{ op: 'holding.archive', id: made.id }]);
    expect(() =>
      previewChanges(t, owner, {
        operations: [
          {
            op: 'holding.trade',
            id: made.id,
            trade: { kind: 'buy', date: '2026-11-12', units: '1', amountRupiah: '1' },
          },
        ],
      }),
    ).toThrow(/archived/i);
  });

  it('returns the same receipt after reopening a persisted database', async () => {
    const t = freshDb(),
      d = previewChanges(t, owner, { operations: [entry(t)] });
    const original = commitChanges(t, owner, d.draftId, d.digest);
    const file = path.join(os.tmpdir(), `moaney-mcp-test-${randomUUID()}.db`);
    await t.raw.backup(file);
    const reopened = openDb(file);
    try {
      expect(commitChanges(reopened, owner, d.draftId, d.digest)).toEqual(original);
      expect(reopened.db.select().from(transactions).all()).toHaveLength(1);
    } finally {
      reopened.raw.close();
      t.raw.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
  });

  it('normalizes an expense into a transfer before validating its effective category', () => {
    const t = freshDb();
    const made = apply(t, [entry(t)]).results[0] as { id: number };
    apply(t, [
      { op: 'transaction.update', id: made.id, patch: { type: 'transfer', toWalletId: t.w('BCA') } },
    ]);
    expect(t.db.select().from(transactions).get()).toMatchObject({
      type: 'transfer',
      categoryId: null,
      toWalletId: t.w('BCA'),
    });
  });

  it('requires active resolved wallet/category references when confirming captured payments', () => {
    const t = freshDb();
    const n = t.db
      .insert(notifications)
      .values({
        app: 'gopay',
        text: 'Test',
        receivedAt: '2026-11-12T10:00:00+07:00',
        kind: 'new_payment',
        direction: 'out',
        amount: 10000,
        walletId: t.w('GoPay'),
        categoryId: t.c('My Food'),
      })
      .returning()
      .get();
    t.raw.prepare('update wallets set archived=1 where id=?').run(t.w('GoPay'));
    expect(() => previewChanges(t, owner, { operations: [{ op: 'capture.confirm', id: n.id }] })).toThrow(
      /archived/i,
    );
    expect(t.db.select().from(transactions).all()).toHaveLength(0);
    expect(t.db.select().from(notifications).get()?.status).toBe('pending');
    apply(t, [{ op: 'capture.confirm', id: n.id, overrides: { walletId: t.w('Cash') } }]);
    expect(t.db.select().from(transactions).get()?.walletId).toBe(t.w('Cash'));
  });
});
