import type { Express, Request, Response } from 'express';
import express from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { requireOwner, verifyPassword } from '../auth/auth.js';
import type { Config } from '../config.js';
import type { DbHandle } from '../db/client.js';
import { McpStore, hash, secret } from './store.js';

export interface Principal {
  grantId: string;
  clientId: string;
  scopes: string[];
}
interface Client {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}
interface Grant extends Principal {
  resource: string;
  revoked: boolean;
  createdAt: string;
}
interface Authorization {
  clientId: string;
  resource: string;
  redirect: string;
  challenge: string;
  state?: string;
  scopes: string[];
}
interface Token {
  grantId: string;
  clientId: string;
  resource: string;
  scopes: string[];
  used?: boolean;
}
const SCOPES = ['moaney:read', 'moaney:write'];
const DAY = 86400_000;
const COOKIE = 'moaney_mcp_consent';
function consentPolicy(res: Response, redirect: string) {
  // Chromium applies form-action to redirects. Allow only this consent's validated callback origin.
  const current = String(res.getHeader('Content-Security-Policy') ?? '');
  res.set(
    'Content-Security-Policy',
    current.replace("form-action 'self'", `form-action 'self' ${new URL(redirect).origin}`),
  );
}
const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const safeRedirect = (s: string) => {
  try {
    const u = new URL(s);
    return (
      !u.username &&
      !u.password &&
      !u.hash &&
      (u.protocol === 'https:' ||
        (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
    );
  } catch {
    return false;
  }
};

/** Small bounded limiter: no attacker-controlled unbounded key map. */
function limiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; end: number }>();
  return (key: string) => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.end <= now) hits.delete(k);
    let hit = hits.get(key);
    if (!hit) {
      if (hits.size >= 10000) return false;
      hit = { n: 0, end: now + windowMs };
      hits.set(key, hit);
    }
    return ++hit.n <= limit;
  };
}

export function mountOAuth(app: Express, handle: DbHandle, config: Config) {
  const store = new McpStore(handle.raw);
  const origin = config.MCP_PUBLIC_URL;
  const resource = `${origin}/mcp`;
  const allowed = limiter(120, 60000),
    registration = limiter(10, 60000),
    passwords = limiter(8, 600000);
  const fail = (res: Response, status: number, error: string) => void res.status(status).json({ error });
  const route =
    (fn: (req: Request, res: Response) => Promise<void> | void) => (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      if (!allowed(req.ip ?? 'unknown')) {
        fail(res, 429, 'rate_limit_exceeded');
        return;
      }
      Promise.resolve()
        .then(() => fn(req, res))
        .catch(() => fail(res, 400, 'invalid_request'));
    };
  app.get(
    ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
    (_req, res) =>
      res.json({
        resource,
        authorization_servers: [origin],
        scopes_supported: SCOPES,
        bearer_methods_supported: ['header'],
      }),
  );
  app.get('/.well-known/oauth-authorization-server', (_req, res) =>
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: SCOPES,
      authorization_response_iss_parameter_supported: true,
    }),
  );
  app.use('/oauth', express.urlencoded({ extended: false, limit: '16kb' }));
  app.post(
    '/oauth/register',
    route((req, res) => {
      store.prune();
      if (!registration(req.ip ?? 'unknown') || store.list('client:').length >= 200) {
        fail(res, 429, 'registration_limit');
        return;
      }
      const b = z
        .object({
          client_name: z.string().trim().max(100).default('MCP client'),
          redirect_uris: z.array(z.string().max(2048).refine(safeRedirect)).min(1).max(10),
          token_endpoint_auth_method: z.literal('none').default('none'),
          grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).optional(),
          response_types: z.array(z.literal('code')).optional(),
        })
        .parse(req.body);
      const client: Client = {
        client_id: secret(),
        client_name: b.client_name,
        redirect_uris: b.redirect_uris,
      };
      store.put(`client:${client.client_id}`, client);
      res.status(201).json({
        ...client,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    }),
  );
  app.get(
    '/oauth/authorize',
    route((req, res) => {
      const b = z
        .object({
          response_type: z.literal('code'),
          client_id: z.string().max(100),
          redirect_uri: z.string().max(2048),
          code_challenge: z.string().regex(/^[\w-]{43}$/),
          code_challenge_method: z.literal('S256'),
          state: z.string().max(2048).optional(),
          resource: z.literal(resource).optional(),
          scope: z.string().max(100).default(SCOPES.join(' ')),
        })
        .parse(req.query);
      const client = store.get<Client>(`client:${b.client_id}`);
      const scopes = [...new Set(b.scope.split(' ').filter(Boolean))];
      if (
        !client?.redirect_uris.includes(b.redirect_uri) ||
        !scopes.includes('moaney:read') ||
        scopes.some((s) => !SCOPES.includes(s))
      ) {
        fail(res, 400, 'invalid_request');
        return;
      }
      store.prune();
      if (store.list('consent:').length >= 500) {
        fail(res, 429, 'too_many_requests');
        return;
      }
      const nonce = secret();
      consentPolicy(res, b.redirect_uri);
      store.put(
        `consent:${hash(nonce)}`,
        {
          clientId: b.client_id,
          resource,
          redirect: b.redirect_uri,
          challenge: b.code_challenge,
          state: b.state,
          scopes,
        } satisfies Authorization,
        600000,
      );
      res.cookie(COOKIE, nonce, {
        httpOnly: true,
        secure: origin.startsWith('https:'),
        sameSite: 'lax',
        path: '/oauth',
        maxAge: 600000,
      });
      res
        .type('html')
        .send(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect to Moaney</title><body><main><h1>Connect to Moaney</h1><p>Application: <strong>${escape(client.client_name)}</strong></p><p>Return address: ${escape(b.redirect_uri)}</p><p>Requested access: ${escape(scopes.join(', '))}. This application can read your private financial records${scopes.includes('moaney:write') ? ' and propose and save changes after your approval' : ''}.</p><p>Approve only if you started this connection. Your password stays with Moaney.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="nonce" value="${nonce}"><label>Moaney password <input name="password" type="password" autocomplete="current-password" required maxlength="200"></label><button name="decision" value="approve">Approve connection</button><button name="decision" value="deny" formnovalidate>Deny</button></form></main></body></html>`,
        );
    }),
  );
  app.post(
    '/oauth/authorize',
    route(async (req, res) => {
      const b = z
        .object({
          nonce: z.string().max(100),
          password: z.string().max(200).default(''),
          decision: z.enum(['approve', 'deny']),
        })
        .parse(req.body);
      const auth = store.get<Authorization>(`consent:${hash(b.nonce)}`);
      if (
        !auth ||
        auth.resource !== resource ||
        req.cookies?.[COOKIE] !== b.nonce ||
        (req.get('origin') && req.get('origin') !== origin)
      ) {
        fail(res, 403, 'invalid_consent');
        return;
      }
      const redirect = new URL(auth.redirect);
      consentPolicy(res, auth.redirect);
      redirect.searchParams.set('iss', origin);
      if (auth.state !== undefined) redirect.searchParams.set('state', auth.state);
      if (b.decision === 'deny') {
        store.remove(`consent:${hash(b.nonce)}`);
        redirect.searchParams.set('error', 'access_denied');
        res.redirect(redirect.href);
        return;
      }
      if (!passwords(req.ip ?? 'unknown')) {
        fail(res, 429, 'rate_limit_exceeded');
        return;
      }
      if (!config.OWNER_PASSWORD_HASH || !(await verifyPassword(b.password, config.OWNER_PASSWORD_HASH))) {
        fail(res, 401, 'invalid_password');
        return;
      }
      // Recheck after asynchronous password verification so two simultaneous approvals cannot reuse consent.
      if (!store.get(`consent:${hash(b.nonce)}`)) {
        fail(res, 403, 'invalid_consent');
        return;
      }
      store.remove(`consent:${hash(b.nonce)}`);
      const code = secret();
      store.put(`code:${hash(code)}`, auth, 300000);
      redirect.searchParams.set('code', code);
      res.clearCookie(COOKIE, { path: '/oauth' }).redirect(redirect.href);
    }),
  );
  const issue = (grant: Grant, scopes = grant.scopes) => {
    const access = secret(),
      refresh = secret();
    store.put(
      `access:${hash(access)}`,
      { grantId: grant.grantId, clientId: grant.clientId, resource, scopes } satisfies Token,
      3600000,
    );
    store.put(
      `refresh:${hash(refresh)}`,
      { grantId: grant.grantId, clientId: grant.clientId, resource, scopes } satisfies Token,
      30 * DAY,
    );
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: scopes.join(' '),
    };
  };
  app.post(
    '/oauth/token',
    route((req, res) => {
      const b = z
        .object({
          grant_type: z.enum(['authorization_code', 'refresh_token']),
          client_id: z.string().max(100),
          code: z.string().max(100).optional(),
          code_verifier: z
            .string()
            .min(43)
            .max(128)
            .regex(/^[\w.~\-]+$/)
            .optional(),
          redirect_uri: z.string().max(2048).optional(),
          refresh_token: z.string().max(100).optional(),
          resource: z.literal(resource).optional(),
          scope: z.string().max(100).optional(),
        })
        .parse(req.body);
      if (!store.get<Client>(`client:${b.client_id}`)) {
        fail(res, 400, 'invalid_client');
        return;
      }
      if (b.grant_type === 'authorization_code') {
        const key = `code:${hash(b.code ?? '')}`,
          auth = store.get<Authorization>(key);
        if (
          !auth ||
          auth.resource !== resource ||
          auth.clientId !== b.client_id ||
          auth.redirect !== b.redirect_uri ||
          !b.code_verifier ||
          createHash('sha256').update(b.code_verifier).digest('base64url') !== auth.challenge
        ) {
          fail(res, 400, 'invalid_grant');
          return;
        }
        store.remove(key);
        const grant: Grant = {
          grantId: secret(),
          clientId: b.client_id,
          resource,
          scopes: auth.scopes,
          revoked: false,
          createdAt: new Date().toISOString(),
        };
        store.put(`grant:${grant.grantId}`, grant);
        res.json(issue(grant));
        return;
      }
      const key = `refresh:${hash(b.refresh_token ?? '')}`,
        token = store.get<Token>(key),
        grant = token && store.get<Grant>(`grant:${token.grantId}`);
      if (
        !token ||
        token.resource !== resource ||
        token.clientId !== b.client_id ||
        !grant ||
        grant.resource !== resource ||
        grant.revoked
      ) {
        fail(res, 400, 'invalid_grant');
        return;
      }
      if (token.used) {
        store.put(`grant:${grant.grantId}`, { ...grant, revoked: true });
        fail(res, 400, 'invalid_grant');
        return;
      }
      const scopes = b.scope ? [...new Set(b.scope.split(' ').filter(Boolean))] : token.scopes;
      if (!scopes.includes('moaney:read') || scopes.some((s) => !token.scopes.includes(s))) {
        fail(res, 400, 'invalid_scope');
        return;
      }
      store.put(key, { ...token, used: true }, 30 * DAY);
      res.json(issue(grant, scopes));
    }),
  );
  app.post(
    '/oauth/revoke',
    route((req, res) => {
      const b = z.object({ token: z.string().max(100), client_id: z.string().max(100) }).parse(req.body);
      const token =
        store.get<Token>(`refresh:${hash(b.token)}`) ?? store.get<Token>(`access:${hash(b.token)}`);
      const grant = token && store.get<Grant>(`grant:${token.grantId}`);
      if (grant && grant.clientId === b.client_id)
        store.put(`grant:${grant.grantId}`, { ...grant, revoked: true });
      res.json({});
    }),
  );
  app.get('/api/v1/mcp/connections', requireOwner(handle.db), (_req, res) =>
    res.json(
      store.list<Grant>('grant:').map(({ value: g }) => ({
        id: g.grantId,
        clientId: g.clientId,
        name: store.get<Client>(`client:${g.clientId}`)?.client_name,
        scopes: g.scopes,
        createdAt: g.createdAt,
        revoked: g.revoked,
      })),
    ),
  );
  app.delete('/api/v1/mcp/connections/:id', requireOwner(handle.db), (req, res) => {
    const key = `grant:${req.params.id}`,
      grant = store.get<Grant>(key);
    if (!grant) {
      fail(res, 404, 'not_found');
      return;
    }
    store.put(key, { ...grant, revoked: true });
    res.json({ ok: true });
  });
  return (token: string): Principal | undefined => {
    const access = store.get<Token>(`access:${hash(token)}`),
      grant = access && store.get<Grant>(`grant:${access.grantId}`);
    if (!grant || grant.resource !== resource || access!.resource !== resource || grant.revoked) return;
    return { grantId: grant.grantId, clientId: grant.clientId, scopes: access!.scopes };
  };
}
