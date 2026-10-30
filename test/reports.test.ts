import { describe, expect, it } from 'vitest';
import { answerQuestion, detectPeriod } from '../src/domain/ask.js';
import { createTransaction } from '../src/domain/ledger.js';
import { overview, periodRange, stepPeriod } from '../src/domain/reports.js';
import { freshDb } from './helpers.js';

const TODAY = '2026-10-30';

function setup() {
  const h = freshDb();
  const base = { walletId: h.w('Cash'), source: 'manual' as const };
  const exp = (date: string, amount: number, desc: string, cat: string) =>
    createTransaction(h.db, { ...base, type: 'expense', amount, categoryId: h.c(cat), description: desc, occurredAt: `${date}T12:00` });
  exp('2026-10-01', 1_000_000, 'Nasbung', 'My Food');
  exp('2026-10-01', 500_000, 'Nasbung', 'My Food');
  exp('2026-10-15', 2_000_000, 'Listrik', 'Household');
  exp('2026-09-02', 700_000, 'Nasbung', 'My Food');
  exp('2026-09-30', 300_000, 'Parkir', 'Others');
  createTransaction(h.db, { ...base, type: 'income', amount: 8_000_000, categoryId: h.c('Salary'), description: 'Gaji', occurredAt: '2026-10-05T09:00' });
  createTransaction(h.db, { type: 'transfer', amount: 999_900, walletId: h.w('Cash'), toWalletId: h.w('BCA'), description: 'Tarik', occurredAt: '2026-10-06T09:00', source: 'manual' });
  return h;
}

describe('period helpers', () => {
  it('finds calendar ranges with Monday-start weeks', () => {
    expect(periodRange('monthly', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('weekly', '2026-10-30')).toEqual({ from: '2026-10-26', to: '2026-11-01' });
    expect(periodRange('yearly', '2026-10-30')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
  it('steps across month ends and years', () => {
    expect(stepPeriod('monthly', '2026-03-31', -1)).toBe('2026-02-28');
    expect(stepPeriod('monthly', '2026-01-15', -1)).toBe('2025-12-15');
    expect(stepPeriod('yearly', '2024-02-29', 1)).toBe('2025-02-28');
  });
});

describe('reports overview', () => {
  it('totals the month, ignores transfers, and breaks down categories', () => {
    const h = setup();
    const o = overview(h.db, 'monthly', '2026-10-20', TODAY);
    expect(o.out).toBe(3_500_000);
    expect(o.in).toBe(8_000_000);
    expect(o.previousOut).toBe(1_000_000);
    expect(o.count).toBe(3);
    expect(o.avgPerDay).toBe(Math.round(3_500_000 / 30));
    expect(o.categories.map((c) => [c.name, c.total])).toEqual([['Household', 2_000_000], ['My Food', 1_500_000]]);
    expect(o.categories[0]!.share).toBeCloseTo(2 / 3.5);
    expect(o.label).toBe('Oct ’26');
  });
  it('builds the heatmap with leading blanks and a per-day trend', () => {
    const h = setup();
    const o = overview(h.db, 'monthly', '2026-10-20', TODAY);
    expect(o.trend).toHaveLength(31);
    expect(o.leadingBlanks).toBe(3); // 1 Oct 2026 is a Thursday
    expect(o.trend[0]!.total).toBe(1_500_000);
    expect(o.trend[14]!.total).toBe(2_000_000);
  });
  it('gives cumulative lines that stop at today for the running month', () => {
    const h = setup();
    const o = overview(h.db, 'monthly', TODAY, TODAY);
    expect(o.cumulative!.current).toHaveLength(30);
    expect(o.cumulative!.current[29]).toBe(3_500_000);
    expect(o.cumulative!.previous).toHaveLength(30);
    expect(o.cumulative!.previous[29]).toBe(1_000_000);
  });
  it('covers yearly (per month), weekly and daily', () => {
    const h = setup();
    const y = overview(h.db, 'yearly', TODAY, TODAY);
    expect(y.trend).toHaveLength(12);
    expect(y.trend[9]!.total).toBe(3_500_000);
    expect(y.trend[8]!.total).toBe(1_000_000);
    expect(y.cumulative).toBeNull();
    const w = overview(h.db, 'weekly', '2026-10-15', TODAY);
    expect(w.trend).toHaveLength(7);
    expect(w.out).toBe(2_000_000);
    const d = overview(h.db, 'daily', '2026-10-15', TODAY);
    expect(d.trend).toHaveLength(7);
    expect(d.trend[6]!.total).toBe(2_000_000);
    expect(d.out).toBe(2_000_000);
  });
  it('is all zeros on an empty period', () => {
    const h = freshDb();
    const o = overview(h.db, 'monthly', TODAY, TODAY);
    expect(o).toMatchObject({ out: 0, in: 0, count: 0, avgPerDay: 0, categories: [] });
  });
});

describe('ask', () => {
  it('detects periods in English and Indonesian', () => {
    expect(detectPeriod('berapa bulan lalu', TODAY)).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(detectPeriod('food in october', TODAY)).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(detectPeriod('pengeluaran desember', TODAY)).toMatchObject({ from: '2025-12-01' });
    expect(detectPeriod('spent yesterday', TODAY)).toMatchObject({ from: '2026-10-29', to: '2026-10-29' });
    expect(detectPeriod('spent this year', TODAY)).toMatchObject({ from: '2026-01-01', to: '2026-12-31' });
  });
  it('answers total spent, optionally for a category, excluding transfers', () => {
    const h = setup();
    const all = answerQuestion(h.db, 'How much did I spend this month?', TODAY);
    expect(all.answer).toBe('You spent Rp35,000 in October 2026.');
    expect(all.facts.find((f) => f.label === 'Left out')!.value).toBe('1 transfer');
    const food = answerQuestion(h.db, 'berapa pengeluaran my food bulan ini', TODAY);
    expect(food.answer).toContain('Rp15,000 on My Food');
    expect(answerQuestion(h.db, 'spent on food in September?', TODAY).answer).toBe('You spent Rp7,000 on My Food + Family Food in September 2026.');
  });
  it('lists top places, compares periods, and reports income', () => {
    const h = setup();
    const top = answerQuestion(h.db, 'Top 2 merchants this month', TODAY);
    expect(top.facts[0]).toEqual({ label: 'Listrik', value: 'Rp20,000 · 1 entry' });
    expect(top.facts[1]).toEqual({ label: 'Nasbung', value: 'Rp15,000 · 2 entries' });
    const cmp = answerQuestion(h.db, 'compare spending with last month', TODAY);
    expect(cmp.answer).toBe('You spent Rp25,000 more in October 2026 than in September 2026.');
    expect(answerQuestion(h.db, 'how much income this month', TODAY).answer).toBe('You received Rp80,000 in October 2026.');
  });
  it('says so when it does not understand, without numbers', () => {
    const h = setup();
    const a = answerQuestion(h.db, 'will I be rich?', TODAY);
    expect(a.answer).toMatch(/could not tell/);
    expect(a.facts).toEqual([]);
    expect(a.followUps.length).toBeGreaterThan(0);
  });
});
