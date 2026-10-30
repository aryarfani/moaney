import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { eq, lt } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import type { Db } from '../db/client.js';
import { sessions } from '../db/schema.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export const COOKIE = 'moaney_session';
const SESSION_DAYS = 30;

/** Format: scrypt$<saltHex>$<hashHex> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function createSession(db: Db): { token: string; csrf: string; expires: Date } {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString())).run();
  db.insert(sessions).values({ idHash: sha(token), csrf, expiresAt: expires.toISOString() }).run();
  return { token, csrf, expires };
}

export function destroySession(db: Db, token: string | undefined): void {
  if (token) db.delete(sessions).where(eq(sessions.idHash, sha(token))).run();
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: { csrf: string };
  }
}

export function requireOwner(db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies?.[COOKIE] as string | undefined;
    const row = token ? db.select().from(sessions).where(eq(sessions.idHash, sha(token))).get() : undefined;
    if (!row || row.expiresAt < new Date().toISOString()) {
      res.status(401).json({ error: 'Sign in required' });
      return;
    }
    req.session = { csrf: row.csrf };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const sent = req.get('x-csrf-token') ?? '';
      const a = Buffer.from(sent);
      const b = Buffer.from(row.csrf);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        res.status(403).json({ error: 'Bad CSRF token' });
        return;
      }
    }
    next();
  };
}

/** Sliding-window limiter: max `limit` hits per key per `windowMs`. */
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}
