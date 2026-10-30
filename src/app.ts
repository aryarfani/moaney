import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { loginInput } from '../shared/schemas.js';
import { COOKIE, createSession, destroySession, rateLimiter, requireOwner, verifyPassword } from './auth/auth.js';
import type { Config } from './config.js';
import type { DbHandle } from './db/client.js';
import { WEB_DIR } from './paths.js';
import { apiRouter, errorHandler } from './routes/api.js';

export function createApp(handle: DbHandle, config: Config, webRoot = WEB_DIR): Express {
  const { db, raw } = handle;
  const app = express();
  app.disable('x-powered-by');
  if (config.BEHIND_TLS) app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Robots-Tag': 'noindex',
    });
    next();
  });
  app.use(express.json({ limit: '25mb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    try {
      raw.prepare('select 1').get();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  const limiter = rateLimiter(8, 10 * 60_000);
  const auth = requireOwner(db);

  app.post('/api/v1/auth/login', async (req, res, next) => {
    try {
      if (!limiter(req.ip ?? 'unknown')) {
        res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
        return;
      }
      const { password } = loginInput.parse(req.body);
      if (!config.OWNER_PASSWORD_HASH || !(await verifyPassword(password, config.OWNER_PASSWORD_HASH))) {
        res.status(401).json({ error: 'Wrong password' });
        return;
      }
      const s = createSession(db);
      res.cookie(COOKIE, s.token, { httpOnly: true, secure: config.BEHIND_TLS, sameSite: 'lax', expires: s.expires, path: '/' });
      res.json({ csrf: s.csrf });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/v1/auth/logout', auth, (req, res) => {
    destroySession(db, req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE, { path: '/' }).json({ ok: true });
  });
  app.get('/api/v1/auth/me', auth, (req, res) => {
    res.json({ csrf: req.session!.csrf });
  });

  app.use('/api/v1', auth, apiRouter(db));
  app.use('/api', (_req, res) => void res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);

  app.use(express.static(webRoot, { index: false, maxAge: '1h', setHeaders: (res, file) => {
    if (file.endsWith('sw.js') || file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  } }));
  app.get('*', (_req, res, next) => {
    res.sendFile(path.join(webRoot, 'index.html'), (err) => err && next());
  });
  return app;
}
