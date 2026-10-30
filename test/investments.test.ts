import { describe, expect, it } from 'vitest';
import { addTrade, archiveHolding, createHolding, formatUnits, holdingDetail, holdingValue, parseUnits, portfolio, setPrice, shares } from '../src/domain/investments.js';
import { LedgerError } from '../src/domain/ledger.js';
import { freshDb } from './helpers.js';

const THIS_YEAR = `${new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 4)}`;

describe('units', () => {
  it('parses decimals into integer units and back', () => {
    expect(parseUnits('23')).toBe(230_000);
    expect(parseUnits('0,5')).toBe(5_000);
    expect(parseUnits('10.2501')).toBe(102_501);
    expect(formatUnits(102_501)).toBe('10,2501');
    expect(formatUnits(230_000)).toBe('23');
    expect(() => parseUnits('1.23456')).toThrow(LedgerError);
    expect(() => parseUnits('-1')).toThrow(LedgerError);
    expect(() => parseUnits('abc')).toThrow(LedgerError);
  });
  it('shares add up to exactly 100', () => {
    expect(shares([1, 1, 1])).toEqual([34, 33, 33]);
    expect(shares([42, 24, 18, 10, 6]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(shares([0, 0])).toEqual([0, 0]);
  });
});

describe('holdings', () => {
  it('buys add units and cost; value uses price, else cost', () => {
    const t = freshDb();
    const h = createHolding(t.db, { symbol: 'BBCA', kind: 'stock', first: { date: '2026-01-05', unitsE4: parseUnits('20'), amount: 18_300_000_00 } });
    expect(h).toMatchObject({ unitsE4: 200_000, cost: 18_300_000_00, price: null });
    expect(holdingValue(h)).toBe(18_300_000_00);
    addTrade(t.db, h.id, { kind: 'buy', date: '2026-02-01', unitsE4: parseUnits('3'), amount: 2_850_000_00 });
    const priced = setPrice(t.db, h.id, 10_050_00, '2026-10-28');
    expect(priced.unitsE4).toBe(230_000);
    expect(holdingValue(priced)).toBe(Math.round((230_000 * 10_050_00) / 10_000));
  });

  it('selling reduces cost by average cost and never goes negative', () => {
    const t = freshDb();
    const h = createHolding(t.db, { symbol: 'VTI', kind: 'fund', first: { date: '2026-01-01', unitsE4: parseUnits('10'), amount: 1_000_001 } });
    addTrade(t.db, h.id, { kind: 'sell', date: '2026-02-01', unitsE4: parseUnits('3'), amount: 400_000 });
    const after = holdingDetail(t.db, h.id);
    expect(after.unitsE4).toBe(70_000);
    expect(after.cost).toBe(1_000_001 - 300_000); // round(1_000_001 * 3 / 10) = 300_000
    expect(() => addTrade(t.db, h.id, { kind: 'sell', date: '2026-02-02', unitsE4: parseUnits('8'), amount: 1 })).toThrow(/more than you hold/);
    addTrade(t.db, h.id, { kind: 'sell', date: '2026-02-03', unitsE4: parseUnits('7'), amount: 1_000 });
    expect(holdingDetail(t.db, h.id)).toMatchObject({ unitsE4: 0, cost: 0 });
    expect(holdingDetail(t.db, h.id).trades).toHaveLength(3);
  });

  it('income counts toward this year only', () => {
    const t = freshDb();
    const h = createHolding(t.db, { symbol: 'ORI025T3', kind: 'sbn', first: { date: '2025-03-01', unitsE4: 1, amount: 4_000_000_00 } });
    addTrade(t.db, h.id, { kind: 'income', date: `${THIS_YEAR}-03-10`, unitsE4: 0, amount: 62_500_00 });
    addTrade(t.db, h.id, { kind: 'income', date: '2001-03-10', unitsE4: 0, amount: 1_000_00 });
    expect(holdingDetail(t.db, h.id).incomeYtd).toBe(62_500_00);
  });

  it('rejects bad trades and unknown holdings', () => {
    const t = freshDb();
    const h = createHolding(t.db, { symbol: 'XAU', kind: 'gold' });
    expect(() => addTrade(t.db, h.id, { kind: 'buy', date: '2026-01-01', unitsE4: 0, amount: 5 })).toThrow(LedgerError);
    expect(() => addTrade(t.db, h.id, { kind: 'buy', date: '2026-01-01', unitsE4: 1, amount: 0 })).toThrow(LedgerError);
    expect(() => addTrade(t.db, 999, { kind: 'buy', date: '2026-01-01', unitsE4: 1, amount: 5 })).toThrow(/not found/);
    expect(() => createHolding(t.db, { symbol: 'XAU', kind: 'gold' })).toThrow(/UNIQUE/);
  });
});

describe('portfolio', () => {
  it('sums value, gain on priced holdings, missing prices and allocation', () => {
    const t = freshDb();
    const a = createHolding(t.db, { symbol: 'BBCA', kind: 'stock', first: { date: '2026-01-01', unitsE4: parseUnits('10'), amount: 1_000_000 } });
    createHolding(t.db, { symbol: 'Gold', kind: 'gold', first: { date: '2026-01-01', unitsE4: parseUnits('10'), amount: 3_000_000 } });
    setPrice(t.db, a.id, 120_000, '2026-10-28'); // 10 * 120_000 = 1_200_000
    const p = portfolio(t.db);
    expect(p.value).toBe(1_200_000 + 3_000_000);
    expect(p.gain).toBe(200_000);
    expect(p.gainBp).toBe(2_000);
    expect(p.priceMissing).toBe(1);
    expect(p.pricesAsOf).toBe('2026-10-28');
    expect(p.allocation.map((x) => x.percent).reduce((s, v) => s + v, 0)).toBe(100);
  });

  it('archived holdings drop out and an empty portfolio is zero', () => {
    const t = freshDb();
    expect(portfolio(t.db)).toMatchObject({ value: 0, gain: 0, gainBp: 0, priceMissing: 0, allocation: [] });
    const h = createHolding(t.db, { symbol: 'X', kind: 'other', first: { date: '2026-01-01', unitsE4: 10_000, amount: 5_000 } });
    archiveHolding(t.db, h.id);
    expect(portfolio(t.db).holdings).toHaveLength(0);
  });
});
