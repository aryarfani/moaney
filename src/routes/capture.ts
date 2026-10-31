import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { transactionInput } from '../../shared/schemas.js';
import type { Db } from '../db/client.js';
import { captureSources, devices, rules } from '../db/schema.js';
import {
  closeDay, confirmEdited, confirmNotification, dismissNotification, getSetting, ignoreWords, keepBoth, keepOne, listPending, ownNames,
  pendingCount, retentionDays, rulesView, setSetting, sourcesView,
} from '../domain/capture.js';
import { LedgerError } from '../domain/ledger.js';
import { hashToken } from './capture-ingest.js';

const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new LedgerError('Bad id');
  return n;
};

const confirmBody = z.object({
  categoryId: z.number().int().positive().nullish(),
  walletId: z.number().int().positive().nullish(),
  description: z.string().trim().max(200).optional(),
  amount: z.number().int().positive().optional(),
});

// Authenticated routes (session cookie + CSRF), mounted under /api/v1.
export function captureRouter(db: Db): Router {
  const r = Router();

  r.get('/capture/pending', (_req, res) => {
    const items = listPending(db);
    res.json({ items, count: items.length });
  });
  r.get('/capture/pending-count', (_req, res) => void res.json({ count: pendingCount(db) }));
  r.post('/capture/close-day', (_req, res) => void res.json(closeDay(db)));
  r.post('/capture/:id/confirm', (req, res) => void res.json(confirmNotification(db, id(req), confirmBody.parse(req.body ?? {}))));
  r.post('/capture/:id/edit-confirm', (req, res) => void res.json(confirmEdited(db, id(req), transactionInput.parse(req.body))));
  r.post('/capture/:id/dismiss', (req, res) => {
    dismissNotification(db, id(req));
    res.json({ ok: true });
  });
  r.post('/capture/:id/keep-both', (req, res) => {
    keepBoth(db, id(req));
    res.json({ ok: true });
  });
  r.post('/capture/:id/keep-one', (req, res) => void res.json({ transaction: keepOne(db, id(req)) }));

  // ---- sources, devices, settings
  r.get('/capture/sources', (_req, res) => {
    res.json({
      ...sourcesView(db),
      devices: db.select({ id: devices.id, name: devices.name, lastSeenAt: devices.lastSeenAt, createdAt: devices.createdAt }).from(devices).all(),
      paused: getSetting(db, 'capture.paused') === 'true',
      names: ownNames(db),
      ignore: ignoreWords(db),
      retentionDays: retentionDays(db),
    });
  });
  r.post('/capture/device', (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(60).default('My phone') }).parse(req.body ?? {});
    const token = randomBytes(32).toString('base64url');
    const row = db.insert(devices).values({ name, tokenHash: hashToken(token) }).returning({ id: devices.id, name: devices.name }).get();
    res.status(201).json({ ...row, token });
  });
  r.delete('/capture/device/:id', (req, res) => {
    db.delete(devices).where(eq(devices.id, id(req))).run();
    res.json({ ok: true });
  });
  r.patch('/capture/sources/:id', (req, res) => {
    const { walletId } = z.object({ walletId: z.number().int().positive().nullable() }).parse(req.body);
    const row = db.update(captureSources).set({ walletId }).where(eq(captureSources.id, id(req))).returning().get();
    if (!row) throw new LedgerError('Source not found', 404);
    res.json(row);
  });
  r.put('/capture/settings', (req, res) => {
    const b = z.object({
      paused: z.boolean().optional(),
      retentionDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
      addName: z.string().trim().min(1).max(80).optional(),
      removeName: z.string().max(80).optional(),
      addIgnore: z.string().trim().toLowerCase().min(2).max(80).optional(),
      removeIgnore: z.string().max(80).optional(),
    }).parse(req.body);
    if (b.addIgnore || b.removeIgnore) {
      const words = ignoreWords(db).filter((w) => w !== b.removeIgnore);
      if (b.addIgnore && !words.includes(b.addIgnore)) words.push(b.addIgnore);
      setSetting(db, 'capture.ignore', JSON.stringify(words));
    }
    if (b.paused !== undefined) setSetting(db, 'capture.paused', String(b.paused));
    if (b.retentionDays !== undefined) setSetting(db, 'capture.retentionDays', String(b.retentionDays));
    if (b.addName || b.removeName) {
      const names = ownNames(db).filter((n) => n !== b.removeName);
      if (b.addName && !names.some((n) => n.toUpperCase() === b.addName!.toUpperCase())) names.push(b.addName.toUpperCase());
      setSetting(db, 'capture.names', JSON.stringify(names));
    }
    res.json({ paused: getSetting(db, 'capture.paused') === 'true', names: ownNames(db), retentionDays: retentionDays(db) });
  });

  // ---- rules
  r.get('/rules', (_req, res) => void res.json(rulesView(db)));
  r.post('/rules/:id/approve', (req, res) => {
    db.update(rules).set({ status: 'active' }).where(eq(rules.id, id(req))).run();
    res.json({ ok: true });
  });
  r.post('/rules/:id/reject', (req, res) => {
    db.update(rules).set({ status: 'pending', chosen: 0 }).where(eq(rules.id, id(req))).run();
    res.json({ ok: true });
  });
  r.patch('/rules/:id', (req, res) => {
    const { status } = z.object({ status: z.enum(['active', 'off']) }).parse(req.body);
    db.update(rules).set({ status }).where(eq(rules.id, id(req))).run();
    res.json({ ok: true });
  });
  return r;
}
