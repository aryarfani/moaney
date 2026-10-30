import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditEvents, journalLines, transactions } from '../src/db/schema.js';
import { createTransaction, LedgerError, updateTransaction, voidTransaction, walletBalances } from '../src/domain/ledger.js';
import { freshDb } from './helpers.js';

const base = { description: '', source: 'manual' as const };

describe('ledger', () => {
  it('expense debits the category and credits the wallet; balance drops', () => {
    const t = freshDb();
    const row = createTransaction(t.db, { ...base, type: 'expense', amount: 1_600_000, walletId: t.w('Cash'), categoryId: t.c('My Food'), description: 'Nasbung' });
    const lines = t.db.select().from(journalLines).where(eq(journalLines.transactionId, row.id)).all();
    expect(lines).toHaveLength(2);
    expect(lines.reduce((s, l) => s + l.debit - l.credit, 0)).toBe(0);
    expect(walletBalances(t.db).get(t.w('Cash'))).toBe(-1_600_000);
  });

  it('a transfer moves money between wallets and is not spending', () => {
    const t = freshDb();
    createTransaction(t.db, { ...base, type: 'transfer', amount: 5_000_000, walletId: t.w('BCA'), toWalletId: t.w('GoPay') });
    const b = walletBalances(t.db);
    expect(b.get(t.w('BCA'))).toBe(-5_000_000);
    expect(b.get(t.w('GoPay'))).toBe(5_000_000);
    expect(t.db.select().from(journalLines).where(eq(journalLines.accountType, 'category')).all()).toHaveLength(0);
  });

  it('lending is a transfer into "Owed to me", repayment moves it back', () => {
    const t = freshDb();
    createTransaction(t.db, { ...base, type: 'transfer', amount: 10_000_000, walletId: t.w('Cash'), toWalletId: t.w('Owed to me') });
    expect(walletBalances(t.db).get(t.w('Owed to me'))).toBe(10_000_000);
    createTransaction(t.db, { ...base, type: 'transfer', amount: 10_000_000, walletId: t.w('Owed to me'), toWalletId: t.w('Cash') });
    expect(walletBalances(t.db).get(t.w('Owed to me'))).toBe(0);
  });

  it('income credits the income category and raises the wallet', () => {
    const t = freshDb();
    createTransaction(t.db, { ...base, type: 'income', amount: 800_000_000, walletId: t.w('BCA'), categoryId: t.c('Salary') });
    expect(walletBalances(t.db).get(t.w('BCA'))).toBe(800_000_000);
  });

  it('editing regenerates journal lines, audits old and new, and moves the balance', () => {
    const t = freshDb();
    const row = createTransaction(t.db, { ...base, type: 'expense', amount: 100_000, walletId: t.w('Cash'), categoryId: t.c('Others') });
    const before = t.db.select().from(journalLines).where(eq(journalLines.transactionId, row.id)).all();
    updateTransaction(t.db, row.id, { amount: 250_000, walletId: t.w('GoPay') });
    const after = t.db.select().from(journalLines).where(eq(journalLines.transactionId, row.id)).all();
    expect(after).toHaveLength(2);
    expect(after.map((l) => l.id)).not.toEqual(before.map((l) => l.id));
    const b = walletBalances(t.db);
    expect(b.get(t.w('Cash'))).toBe(0);
    expect(b.get(t.w('GoPay'))).toBe(-250_000);
    const events = t.db.select().from(auditEvents).where(eq(auditEvents.entityId, row.id)).all();
    expect(events.map((e) => e.action)).toEqual(['create', 'update']);
    expect(JSON.parse(events[1]!.oldValue!).amount).toBe(100_000);
    expect(JSON.parse(events[1]!.newValue!).amount).toBe(250_000);
  });

  it('changing expense to transfer swaps category for destination', () => {
    const t = freshDb();
    const row = createTransaction(t.db, { ...base, type: 'expense', amount: 100_000, walletId: t.w('BCA'), categoryId: t.c('Others') });
    updateTransaction(t.db, row.id, { type: 'transfer', toWalletId: t.w('GoPay'), categoryId: null });
    const b = walletBalances(t.db);
    expect(b.get(t.w('BCA'))).toBe(-100_000);
    expect(b.get(t.w('GoPay'))).toBe(100_000);
  });

  it('void keeps an audit row and removes the effect on balances', () => {
    const t = freshDb();
    const row = createTransaction(t.db, { ...base, type: 'expense', amount: 100_000, walletId: t.w('Cash'), categoryId: t.c('Others') });
    voidTransaction(t.db, row.id, 'owner', 'duplicate');
    expect(walletBalances(t.db).get(t.w('Cash'))).toBe(0);
    expect(t.db.select().from(transactions).where(eq(transactions.id, row.id)).get()?.status).toBe('void');
    const last = t.db.select().from(auditEvents).where(eq(auditEvents.entityId, row.id)).all().at(-1)!;
    expect(last.action).toBe('void');
    expect(last.reason).toBe('duplicate');
    expect(() => updateTransaction(t.db, row.id, { amount: 1 })).toThrow(LedgerError);
  });

  it('balances are reproducible from journal lines alone', () => {
    const t = freshDb();
    for (let i = 1; i <= 20; i++) {
      createTransaction(t.db, { ...base, type: i % 5 === 0 ? 'transfer' : 'expense', amount: i * 10_000, walletId: t.w(i % 2 ? 'Cash' : 'GoPay'), toWalletId: i % 5 === 0 ? t.w('BCA') : null, categoryId: i % 5 === 0 ? null : t.c('My Food') });
    }
    const expected = walletBalances(t.db);
    const rows = t.raw.prepare(`select account_id id, sum(debit - credit) net from journal_lines jl join transactions x on x.id = jl.transaction_id where account_type='wallet' and x.status='posted' group by account_id`).all() as { id: number; net: number }[];
    for (const r of rows) expect(expected.get(r.id)).toBe(r.net);
    const total = t.raw.prepare('select sum(debit) d, sum(credit) c from journal_lines').get() as { d: number; c: number };
    expect(total.d).toBe(total.c);
  });

  it('rejects bad input: same-wallet transfer, wrong category kind, history transfer', () => {
    const t = freshDb();
    expect(() => createTransaction(t.db, { ...base, type: 'transfer', amount: 1, walletId: t.w('Cash'), toWalletId: t.w('Cash') })).toThrow(/different/);
    expect(() => createTransaction(t.db, { ...base, type: 'expense', amount: 1, walletId: t.w('Cash'), categoryId: t.c('Salary') })).toThrow(/for income/);
    expect(() => createTransaction(t.db, { ...base, type: 'transfer', amount: 1, walletId: t.w('Cash'), toWalletId: t.w('Before Moaney') })).toThrow(/History/);
    expect(() => createTransaction(t.db, { ...base, type: 'expense', amount: 1, walletId: t.w('Cash') })).toThrow(/category/);
  });

  it('history wallet entries show in the ledger but are flagged out of totals by the API layer', () => {
    const t = freshDb();
    createTransaction(t.db, { ...base, type: 'expense', amount: 900_000, walletId: t.w('Before Moaney'), categoryId: t.c('My Food') });
    expect(walletBalances(t.db).get(t.w('Before Moaney'))).toBe(-900_000);
  });
});
