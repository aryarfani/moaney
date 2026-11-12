import { createHash } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/auth.js';
import { loadConfig } from '../src/config.js';
import { freshDb } from './helpers.js';

export const ORIGIN = 'http://127.0.0.1:8790';
export const RESOURCE = `${ORIGIN}/mcp`;
export const PASSWORD = 'mcp integration test password';
export const VERIFIER = 'v'.repeat(64);
export const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

export async function mcpBoot() {
  const handle = freshDb();
  const config = loadConfig({ OWNER_PASSWORD_HASH: await hashPassword(PASSWORD), MCP_PUBLIC_URL: ORIGIN });
  const app = createApp(handle, config);
  return { handle, config, app };
}

export async function oauthGrant(app: ReturnType<typeof createApp>, scope = 'moaney:read moaney:write') {
  const registered = await request(app)
    .post('/oauth/register')
    .send({
      client_name: 'Test assistant',
      redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none',
    });
  if (registered.status !== 201) throw new Error(`Registration failed: ${registered.status}`);
  const clientId = registered.body.client_id as string;
  const agent = request.agent(app);
  const consent = await agent.get('/oauth/authorize').query({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'https://client.example/callback',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'client-state',
    resource: RESOURCE,
    scope,
  });
  const nonce = consent.text.match(/name="nonce" value="([^"]+)"/)?.[1];
  if (!nonce) throw new Error(`Consent failed: ${consent.status}`);
  const approved = await agent
    .post('/oauth/authorize')
    .type('form')
    .send({ nonce, password: PASSWORD, decision: 'approve' });
  if (approved.status !== 302) throw new Error(`Approval failed: ${approved.status}`);
  const callback = new URL(approved.headers.location!);
  const code = callback.searchParams.get('code')!;
  const exchange = {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: VERIFIER,
    redirect_uri: 'https://client.example/callback',
    resource: RESOURCE,
  };
  const tokens = await request(app).post('/oauth/token').type('form').send(exchange);
  if (tokens.status !== 200) throw new Error(`Token exchange failed: ${tokens.status} ${tokens.text}`);
  return {
    clientId,
    code,
    exchange,
    tokens: tokens.body as { access_token: string; refresh_token: string; scope: string },
  };
}
