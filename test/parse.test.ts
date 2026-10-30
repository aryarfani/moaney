import { describe, expect, it } from 'vitest';
import { decimalToMinor, formatCompact, formatMoney, parseHumanAmount } from '../shared/money.js';
import { parseEntries, type ParseContext } from '../src/domain/parse-entry.js';

describe('money', () => {
  it('parses human amounts into minor units (exponent 2) without floats', () => {
    expect(parseHumanAmount('28k')).toBe(2_800_000);
    expect(parseHumanAmount('16000')).toBe(1_600_000);
    expect(parseHumanAmount('Rp 38.500')).toBe(3_850_000);
    expect(parseHumanAmount('38,500')).toBe(3_850_000);
    expect(parseHumanAmount('2,5jt')).toBe(250_000_000);
    expect(parseHumanAmount('1.5k')).toBe(150_000);
    expect(parseHumanAmount('1.250.000')).toBe(125_000_000);
    expect(parseHumanAmount('12,5')).toBeNull();
    expect(parseHumanAmount('abc')).toBeNull();
  });
  it('decimalToMinor handles decimals exactly and rejects lost precision', () => {
    expect(decimalToMinor('10000.50')).toBe(1_000_050);
    expect(decimalToMinor('0.07')).toBe(7);
    expect(decimalToMinor('1.005')).toBeNull();
    expect(decimalToMinor('1,000')).toBeNull();
  });
  it('formats in both locales and compactly', () => {
    expect(formatMoney(3_850_000, 'en')).toBe('Rp38,500');
    expect(formatMoney(3_850_000, 'id')).toBe('Rp 38.500');
    expect(formatMoney(1_000_050, 'en')).toBe('Rp10,000.5');
    expect(formatCompact(3_200_000)).toBe('Rp32k');
    expect(formatCompact(250_000_000)).toBe('Rp2.5m');
  });
});

const ctx: ParseContext = {
  wallets: [{ id: 1, name: 'BCA' }, { id: 2, name: 'Jago' }, { id: 3, name: 'GoPay' }, { id: 4, name: 'Cash' }],
  incomeCategories: [{ id: 90, name: 'Salary' }, { id: 91, name: 'Other income' }],
  categoryByDescription: new Map([['kopi', 7]]),
  defaultWalletId: 4,
  defaultExpenseCategoryId: 5,
};

describe('typed entry', () => {
  it('parses "kopi 28k gopay"', () => {
    const [p] = parseEntries('kopi 28k gopay', ctx);
    expect(p).toMatchObject({ type: 'expense', amount: 2_800_000, description: 'kopi', walletId: 3, categoryId: 7, problems: [] });
  });
  it('splits several items on dan / and / commas but not decimals', () => {
    const r = parseEntries('nasbung 16k dan es teh 5k pakai cash, bensin 2,5jt', ctx);
    expect(r.map((x) => [x.description, x.amount])).toEqual([['nasbung', 1_600_000], ['es teh', 500_000], ['bensin', 250_000_000]]);
    expect(r[1]!.walletId).toBe(4);
  });
  it('uses the default wallet and default category for unknown things', () => {
    const [p] = parseEntries('parkir 3k', ctx);
    expect(p).toMatchObject({ walletId: 4, categoryId: 5, amount: 300_000 });
  });
  it('flags missing amount and unknown wallet', () => {
    expect(parseEntries('kopi', ctx)[0]!.problems).toContain('No amount found');
    expect(parseEntries('kopi 10k pakai ovo', ctx)[0]!.problems.join()).toMatch(/Unknown wallet/);
  });
  it('"@2" makes two separate entries, each with the full amount and learned category', () => {
    const r = parseEntries('kopi 28k @2 gopay', ctx);
    expect(r).toHaveLength(2);
    for (const p of r) expect(p).toMatchObject({ description: 'kopi', amount: 2_800_000, walletId: 3, categoryId: 7, problems: [] });
  });
  it('"x2" multiplies the amount into one entry', () => {
    const r = parseEntries('kopi 16k x2', ctx);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ description: 'kopi', amount: 3_200_000 });
    expect(parseEntries('kopi 16k ×3', ctx)[0]!.amount).toBe(4_800_000);
  });
  it('applies per item and guards silly counts', () => {
    expect(parseEntries('kopi 16k @2 dan parkir 3k', ctx).map((p) => p.description)).toEqual(['kopi', 'kopi', 'parkir']);
    expect(parseEntries('kopi 16k @99', ctx)[0]!.problems.join()).toMatch(/more than 20/);
    expect(parseEntries('kopi 16k @0', ctx)[0]!.problems.join()).toMatch(/@0/);
  });
  it('recognises income and transfers', () => {
    expect(parseEntries('gaji 8jt bca', ctx)[0]).toMatchObject({ type: 'income', amount: 800_000_000, walletId: 1, categoryId: 90 });
    expect(parseEntries('transfer bca ke gopay 500k', ctx)[0]).toMatchObject({ type: 'transfer', walletId: 1, toWalletId: 3, amount: 50_000_000 });
  });
});
