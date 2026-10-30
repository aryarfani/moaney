import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, or } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { auditEvents, bills, categories, goals, transactions, wallets } from '../db/schema.js';
import { LedgerError, walletBalances } from '../domain/ledger.js';
import { categoriesOverview, getSetting, payBill, SETTING_KEYS, setSetting, settingsSummary, type SettingKey } from '../domain/plan.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const goalInput = z.object({
  name: z.string().trim().min(1).max(60),
  target: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  saved: z.number().int().nonnegative().default(0),
  walletId: z.number().int().positive().nullish(),
  dueDate: date.nullish(),
});
const goalPatch = goalInput.partial().extend({ archived: z.boolean().optional() });
const billInput = z.object({
  name: z.string().trim().min(1).max(60),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  walletId: z.number().int().positive(),
  categoryId: z.number().int().positive(),
  nextDue: date,
});
const billPatch = billInput.partial().extend({ active: z.boolean().optional() });

const id = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new LedgerError('Bad id');
  return n;
};

const SETTING_VALUES: Record<SettingKey, z.ZodType<string>> = {
  'bills.autoMatch': z.enum(['true', 'false']),
  'capture.retentionDays': z.enum(['7', '30', '90']),
};

export function planRouter(db: Db): Router {
  const r = Router();
  const audit = (action: string, entity: string, entityId: number, oldV: unknown, newV: unknown) =>
    db.insert(auditEvents).values({ actor: 'owner', action, entity, entityId, oldValue: oldV ? JSON.stringify(oldV) : null, newValue: newV ? JSON.stringify(newV) : null }).run();

  // ---- settings hub + simple keys
  r.get('/settings/summary', (_req, res) => void res.json(settingsSummary(db)));
  r.get('/settings/values', (_req, res) => {
    res.json(Object.fromEntries(SETTING_KEYS.map((k) => [k, getSetting(db, k)])));
  });
  r.put('/settings/values/:key', (req, res) => {
    const key = req.params.key as SettingKey;
    if (!SETTING_KEYS.includes(key)) throw new LedgerError('Unknown setting', 404);
    const { value } = z.object({ value: SETTING_VALUES[key] }).parse(req.body);
    setSetting(db, key, value);
    res.json({ key, value });
  });

  // ---- wallet detail
  r.get('/wallets/:id/detail', (req, res) => {
    const wid = id(req.params.id);
    const wallet = db.select().from(wallets).where(eq(wallets.id, wid)).get();
    if (!wallet) throw new LedgerError('Wallet not found', 404);
    const recent = db.select().from(transactions)
      .where(and(eq(transactions.status, 'posted'), or(eq(transactions.walletId, wid), eq(transactions.toWalletId, wid))))
      .orderBy(desc(transactions.occurredAt), desc(transactions.id)).limit(20).all();
    res.json({ wallet: { ...wallet, balance: walletBalances(db).get(wid) ?? 0, countsTowardTotal: wallet.kind !== 'history' }, recent });
  });

  // ---- categories overview
  r.get('/categories/overview', (req, res) => {
    const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).default(new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7)).parse(req.query.month);
    res.json(categoriesOverview(db, month));
  });

  // ---- goals
  r.get('/goals', (_req, res) => void res.json(db.select().from(goals).where(eq(goals.archived, false)).orderBy(goals.id).all()));
  r.post('/goals', (req, res) => {
    const row = db.insert(goals).values(goalInput.parse(req.body)).returning().get();
    audit('create', 'goal', row.id, null, row);
    res.status(201).json(row);
  });
  r.patch('/goals/:id', (req, res) => {
    const gid = id(req.params.id);
    const old = db.select().from(goals).where(eq(goals.id, gid)).get();
    if (!old) throw new LedgerError('Goal not found', 404);
    const row = db.update(goals).set(goalPatch.parse(req.body)).where(eq(goals.id, gid)).returning().get();
    audit('update', 'goal', gid, old, row);
    res.json(row);
  });
  r.post('/goals/:id/add', (req, res) => {
    const gid = id(req.params.id);
    const { amount } = z.object({ amount: z.number().int().positive() }).parse(req.body);
    const old = db.select().from(goals).where(eq(goals.id, gid)).get();
    if (!old) throw new LedgerError('Goal not found', 404);
    if (!Number.isSafeInteger(old.saved + amount)) throw new LedgerError('Amount too large');
    const row = db.update(goals).set({ saved: old.saved + amount }).where(eq(goals.id, gid)).returning().get();
    audit('update', 'goal', gid, old, row);
    res.json(row);
  });

  // ---- bills
  const checkBill = (b: { walletId?: number; categoryId?: number }) => {
    if (b.walletId && !db.select().from(wallets).where(eq(wallets.id, b.walletId)).get()) throw new LedgerError('Wallet not found', 404);
    if (b.categoryId) {
      const c = db.select().from(categories).where(eq(categories.id, b.categoryId)).get();
      if (!c) throw new LedgerError('Category not found', 404);
      if (c.kind !== 'expense') throw new LedgerError('Pick an expense category');
    }
  };
  r.get('/bills', (_req, res) => void res.json(db.select().from(bills).where(eq(bills.active, true)).orderBy(bills.nextDue, bills.id).all()));
  r.post('/bills', (req, res) => {
    const body = billInput.parse(req.body);
    checkBill(body);
    const row = db.insert(bills).values(body).returning().get();
    audit('create', 'bill', row.id, null, row);
    res.status(201).json(row);
  });
  r.patch('/bills/:id', (req, res) => {
    const bid = id(req.params.id);
    const old = db.select().from(bills).where(eq(bills.id, bid)).get();
    if (!old) throw new LedgerError('Bill not found', 404);
    const body = billPatch.parse(req.body);
    checkBill(body);
    const row = db.update(bills).set(body).where(eq(bills.id, bid)).returning().get();
    audit('update', 'bill', bid, old, row);
    res.json(row);
  });
  r.post('/bills/:id/pay', (req, res) => void res.json(payBill(db, id(req.params.id))));

  // ---- data status
  r.get('/data/status', (_req, res) => {
    const dir = process.env.BACKUP_DIR ?? './data/backups';
    let backup: { name: string; size: number; at: string } | null = null;
    try {
      const files = fs.readdirSync(dir).filter((f) => /^moaney-.*\.db$/.test(f)).sort();
      const last = files[files.length - 1];
      if (last) {
        const st = fs.statSync(path.join(dir, last));
        backup = { name: last, size: st.size, at: st.mtime.toISOString() };
      }
    } catch {
      // no backup directory yet
    }
    res.json({ backup, retentionDays: Number(getSetting(db, 'capture.retentionDays')) });
  });

  return r;
}
