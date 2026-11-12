import { createHash } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { freshDb } from './helpers.js';
import { CHALLENGE, mcpBoot, oauthGrant, ORIGIN, PASSWORD, RESOURCE, VERIFIER } from './mcp-helpers.js';

describe('MCP OAuth', () => {
  it('allows only the validated OAuth callback through the consent form redirect policy', async () => {
    const { app } = await mcpBoot();
    const reg = await request(app)
      .post('/oauth/register')
      .send({ redirect_uris: ['https://client.example/callback'] });
    const agent = request.agent(app);
    const form = await agent
      .get('/oauth/authorize')
      .query({
        response_type: 'code',
        client_id: reg.body.client_id,
        redirect_uri: 'https://client.example/callback',
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
      });
    const policy = form.headers['content-security-policy'] ?? '';
    const allowed = policy.match(/(?:^|;)\s*form-action\s+([^;]+)/)?.[1]?.split(' ') ?? [];
    expect(allowed).toEqual(["'self'", 'https://client.example']);
    const nonce = form.text.match(/name="nonce" value="([^"]+)"/)![1];
    const approved = await agent
      .post('/oauth/authorize')
      .type('form')
      .send({ nonce, password: PASSWORD, decision: 'approve' });
    expect(approved.status).toBe(302);
    expect(approved.headers['content-security-policy']).toContain('https://client.example');
  });

  it('normalizes configured origins before cookie security and browser Origin validation', async () => {
    const { handle, config } = await mcpBoot();
    const normalized = loadConfig({
      MCP_PUBLIC_URL: 'HTTPS://MOANEY.EXAMPLE:443/',
      OWNER_PASSWORD_HASH: config.OWNER_PASSWORD_HASH,
    });
    const app = createApp(handle, normalized);
    const reg = await request(app)
      .post('/oauth/register')
      .send({ redirect_uris: ['https://client.example/callback'] });
    const form = await request(app)
      .get('/oauth/authorize')
      .query({
        response_type: 'code',
        client_id: reg.body.client_id,
        redirect_uri: 'https://client.example/callback',
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
      });
    const cookies = form.headers['set-cookie'] as unknown as string[];
    expect(cookies[0]).toContain('; Secure');
    const nonce = form.text.match(/name="nonce" value="([^"]+)"/)![1];
    const approval = await request(app)
      .post('/oauth/authorize')
      .set('Origin', 'https://moaney.example')
      .set('Cookie', cookies[0]!.split(';')[0]!)
      .type('form')
      .send({ nonce, password: PASSWORD, decision: 'approve' });
    expect(approval.status).toBe(302);
    expect(new URL(approval.headers.location!).searchParams.get('iss')).toBe('https://moaney.example');
  });

  it('keeps MCP disabled until a canonical public URL is configured', async () => {
    const h = freshDb();
    const res = await request(createApp(h, loadConfig({})))
      .post('/mcp')
      .send({});
    expect(res.status).toBe(404);
  });

  it('publishes canonical discovery and never derives issuer from the Host header', async () => {
    const { app } = await mcpBoot();
    const resource = await request(app)
      .get('/.well-known/oauth-protected-resource/mcp')
      .set('Host', 'attacker.invalid');
    expect(resource.body).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [ORIGIN],
      scopes_supported: ['moaney:read', 'moaney:write'],
    });
    const meta = await request(app).get('/.well-known/oauth-authorization-server');
    expect(meta.body).toMatchObject({
      issuer: ORIGIN,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  it('exchanges a single-use PKCE code and persists only token hashes', async () => {
    const { app, handle } = await mcpBoot();
    const grant = await oauthGrant(app);
    expect(grant.tokens.scope).toBe('moaney:read moaney:write');
    expect((await request(app).post('/oauth/token').type('form').send(grant.exchange)).status).toBe(400);
    const state = JSON.stringify(handle.raw.prepare('select * from mcp_records').all());
    expect(state).not.toContain(grant.tokens.access_token);
    expect(state).not.toContain(grant.tokens.refresh_token);
    expect(state).not.toContain(grant.code);
    expect(state).toContain(createHash('sha256').update(grant.tokens.access_token).digest('hex'));
  });

  it('requires the consent cookie, owner password, S256 and an exact registered redirect', async () => {
    const { app } = await mcpBoot();
    const reg = await request(app)
      .post('/oauth/register')
      .send({ client_name: '<script>bad</script>', redirect_uris: ['https://client.example/callback'] });
    const q = {
      response_type: 'code',
      client_id: reg.body.client_id,
      redirect_uri: 'https://client.example/callback',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      resource: RESOURCE,
    };
    expect(
      (
        await request(app)
          .get('/oauth/authorize')
          .query({ ...q, redirect_uri: 'https://evil.example' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .get('/oauth/authorize')
          .query({ ...q, code_challenge_method: 'plain' })
      ).status,
    ).toBe(400);
    const agent = request.agent(app);
    const form = await agent.get('/oauth/authorize').query(q);
    expect(form.text).not.toContain('<script>bad</script>');
    const nonce = form.text.match(/name="nonce" value="([^"]+)"/)![1];
    expect(
      (
        await request(app)
          .post('/oauth/authorize')
          .type('form')
          .send({ nonce, password: PASSWORD, decision: 'approve' })
      ).status,
    ).toBe(403);
    expect(
      (
        await agent
          .post('/oauth/authorize')
          .type('form')
          .send({ nonce, password: 'wrong', decision: 'approve' })
      ).status,
    ).toBe(401);
    expect(
      (
        await agent
          .post('/oauth/authorize')
          .type('form')
          .send({ nonce, password: PASSWORD, decision: 'approve' })
      ).status,
    ).toBe(302);
  });

  it('rejects wrong verifier, resource, client and redirect without issuing tokens', async () => {
    const { app } = await mcpBoot();
    const reg = await request(app)
      .post('/oauth/register')
      .send({ redirect_uris: ['http://127.0.0.1:4312/callback'] });
    const agent = request.agent(app);
    const form = await agent.get('/oauth/authorize').query({
      response_type: 'code',
      client_id: reg.body.client_id,
      redirect_uri: 'http://127.0.0.1:4312/callback',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    const nonce = form.text.match(/name="nonce" value="([^"]+)"/)![1];
    const approval = await agent
      .post('/oauth/authorize')
      .type('form')
      .send({ nonce, password: PASSWORD, decision: 'approve' });
    const code = new URL(approval.headers.location!).searchParams.get('code');
    const exchange = {
      grant_type: 'authorization_code',
      client_id: reg.body.client_id,
      code,
      code_verifier: VERIFIER,
      redirect_uri: 'http://127.0.0.1:4312/callback',
      resource: RESOURCE,
    };
    for (const bad of [
      { code_verifier: 'x'.repeat(64) },
      { resource: 'https://evil.example/mcp' },
      { client_id: 'other' },
      { redirect_uri: 'http://127.0.0.1:4312/other' },
    ]) {
      expect(
        (
          await request(app)
            .post('/oauth/token')
            .type('form')
            .send({ ...exchange, ...bad })
        ).status,
      ).toBe(400);
    }
  });

  it('rotates refresh tokens, prevents scope escalation and revokes a replayed token family', async () => {
    const { app } = await mcpBoot();
    const grant = await oauthGrant(app, 'moaney:read');
    const refresh = {
      grant_type: 'refresh_token',
      client_id: grant.clientId,
      refresh_token: grant.tokens.refresh_token,
      resource: RESOURCE,
    };
    expect(
      (
        await request(app)
          .post('/oauth/token')
          .type('form')
          .send({ ...refresh, scope: 'moaney:read moaney:write' })
      ).status,
    ).toBe(400);
    const rotated = await request(app).post('/oauth/token').type('form').send(refresh);
    expect(rotated.status).toBe(200);
    expect(rotated.body.scope).toBe('moaney:read');
    expect(rotated.body.refresh_token).not.toBe(grant.tokens.refresh_token);
    expect((await request(app).post('/oauth/token').type('form').send(refresh)).status).toBe(400);
    expect(
      (
        await request(app)
          .post('/oauth/token')
          .type('form')
          .send({ ...refresh, refresh_token: rotated.body.refresh_token })
      ).status,
    ).toBe(400);
  });

  it('rejects non-HTTPS public endpoints and unsafe registration URIs', async () => {
    expect(() => loadConfig({ MCP_PUBLIC_URL: 'http://public.example' })).toThrow();
    const { app } = await mcpBoot();
    for (const uri of [
      'javascript:alert(1)',
      'http://evil.example/cb',
      'https://user:password@client.example/cb',
      'https://client.example/cb#fragment',
    ]) {
      expect(
        (
          await request(app)
            .post('/oauth/register')
            .send({ redirect_uris: [uri] })
        ).status,
      ).toBe(400);
    }
  });

  it('honors narrowed refresh scopes without allowing later escalation', async () => {
    const { app } = await mcpBoot();
    const grant = await oauthGrant(app);
    const refresh = {
      grant_type: 'refresh_token',
      client_id: grant.clientId,
      refresh_token: grant.tokens.refresh_token,
      resource: RESOURCE,
      scope: 'moaney:read',
    };
    const narrowed = await request(app).post('/oauth/token').type('form').send(refresh);
    expect(narrowed.body.scope).toBe('moaney:read');
    expect(
      (
        await request(app)
          .post('/oauth/token')
          .type('form')
          .send({ ...refresh, refresh_token: narrowed.body.refresh_token, scope: 'moaney:read moaney:write' })
      ).status,
    ).toBe(400);
  });

  it('binds existing tokens to the issuing resource after a configuration change', async () => {
    const { app, handle, config } = await mcpBoot();
    const grant = await oauthGrant(app);
    const changed = createApp(handle, { ...config, MCP_PUBLIC_URL: 'http://localhost:8790' });
    expect(
      (
        await request(changed)
          .post('/mcp')
          .set('Authorization', `Bearer ${grant.tokens.access_token}`)
          .send({})
      ).status,
    ).toBe(401);
    expect(
      (
        await request(changed).post('/oauth/token').type('form').send({
          grant_type: 'refresh_token',
          client_id: grant.clientId,
          refresh_token: grant.tokens.refresh_token,
        })
      ).status,
    ).toBe(400);
  });
});
