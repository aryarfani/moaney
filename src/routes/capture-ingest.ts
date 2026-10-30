import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { devices } from '../db/schema.js';
import { getSetting, ingest, isSecurityText, normaliseApp } from '../domain/capture.js';
import { LedgerError } from '../domain/ledger.js';
import { jakartaNow } from '../domain/time.js';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const body = z.object({
  app: z.string().min(1).max(100),
  title: z.string().max(300).optional(),
  text: z.string().min(1).max(2000),
  postedAt: z.union([z.number(), z.string().max(40)]).optional(),
});

/** Phones send whatever their automation app builds, so accept JSON, form encoding, or JSON broken by unescaped quotes in the text. */
export function parseBody(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const t = raw.trim();
  try {
    return JSON.parse(t);
  } catch {
    // fall through
  }
  if (!t.startsWith('{')) {
    const f = new URLSearchParams(t);
    if (f.has('text')) return Object.fromEntries(f);
  }
  const field = (name: string) => new RegExp(String.raw`"${name}"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"(?:app|title|text|postedAt)"\s*:|\}\s*$)`).exec(t)?.[1];
  return { app: field('app'), title: field('title'), text: field('text'), postedAt: field('postedAt') };
}

function postedAt(v: number | string | undefined): string {
  if (v === undefined) return jakartaNow();
  const d = new Date(typeof v === 'string' && /^\d{10,}$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? jakartaNow() : jakartaNow(d);
}

/** Phone -> server notification ingest, authenticated by a device token instead of the owner's cookie. */
export function captureIngestRouter(db: Db): Router {
  const r = Router();
  const hits = new Map<string, number[]>();
  const allowed = (key: string) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(key, recent);
    return recent.length <= 60;
  };

  r.post('/notifications', (req, res) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
    const device = m ? db.select().from(devices).where(eq(devices.tokenHash, hashToken(m[1]!))).get() : undefined;
    if (!device) {
      res.status(401).json({ error: 'Unknown device token' });
      return;
    }
    if (!allowed(device.tokenHash)) {
      res.status(429).json({ error: 'Slow down' });
      return;
    }
    const input = body.parse(parseBody(req.body));
    db.update(devices).set({ lastSeenAt: jakartaNow() }).where(eq(devices.id, device.id)).run();

    const app = normaliseApp(input.app);
    if (!app) throw new LedgerError('Unknown app', 400);
    if (isSecurityText(`${input.title ?? ''} ${input.text}`)) {
      res.status(202).json({ dropped: 'security' });
      return;
    }
    if (getSetting(db, 'capture.paused') === 'true') {
      res.status(202).json({ paused: true });
      return;
    }
    const row = ingest(db, { app, title: input.title, text: input.text, receivedAt: postedAt(input.postedAt) });
    res.status(201).json({ id: row.id, kind: row.kind });
  });
  return r;
}
