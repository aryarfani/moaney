import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { addTrade, archiveHolding, createHolding, HOLDING_KINDS, holdingDetail, parseUnits, portfolio, setPrice, updateHolding } from '../domain/investments.js';
import { LedgerError } from '../domain/ledger.js';
import { today } from '../domain/time.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const units = z.string().trim().max(20);

const newHolding = z.object({
  symbol: z.string().trim().min(1).max(30),
  name: z.string().trim().max(80).default(''),
  kind: z.enum(HOLDING_KINDS),
  unitLabel: z.string().trim().max(12).optional(),
  note: z.string().trim().max(500).nullish(),
  price: money.nullish(),
  priceDate: date.nullish(),
  first: z.object({ date, units, amount: money.positive() }).nullish(),
});
const tradeInput = z.object({
  kind: z.enum(['buy', 'sell', 'income']),
  date,
  units: units.default('0'),
  amount: money.positive(),
});
const patch = z.object({
  name: z.string().trim().max(80).optional(),
  kind: z.enum(HOLDING_KINDS).optional(),
  unitLabel: z.string().trim().max(12).optional(),
  note: z.string().trim().max(500).nullish(),
});

const hid = (id: string | string[] | undefined) => {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new LedgerError('Bad id');
  return n;
};

// Authenticated routes (session cookie + CSRF), mounted under /api/v1.
export function investmentsRouter(db: Db): Router {
  const r = Router();

  r.get('/investments', (_req, res) => {
    res.json(portfolio(db));
  });
  r.post('/investments', (req, res) => {
    const b = newHolding.parse(req.body);
    const row = createHolding(db, {
      ...b,
      first: b.first ? { date: b.first.date, unitsE4: parseUnits(b.first.units), amount: b.first.amount } : null,
    });
    res.status(201).json(holdingDetail(db, row.id));
  });
  r.get('/investments/:id', (req, res) => {
    res.json(holdingDetail(db, hid(req.params.id)));
  });
  r.patch('/investments/:id', (req, res) => {
    const id = hid(req.params.id);
    updateHolding(db, id, patch.parse(req.body));
    res.json(holdingDetail(db, id));
  });
  r.delete('/investments/:id', (req, res) => {
    archiveHolding(db, hid(req.params.id));
    res.json({ ok: true });
  });
  r.post('/investments/:id/trades', (req, res) => {
    const id = hid(req.params.id);
    const b = tradeInput.parse(req.body);
    addTrade(db, id, { kind: b.kind, date: b.date, unitsE4: b.kind === 'income' ? 0 : parseUnits(b.units), amount: b.amount });
    res.status(201).json(holdingDetail(db, id));
  });
  r.put('/investments/:id/price', (req, res) => {
    const id = hid(req.params.id);
    const b = z.object({ price: money, date: date.default(today()) }).parse(req.body);
    setPrice(db, id, b.price, b.date);
    res.json(holdingDetail(db, id));
  });

  return r;
}
