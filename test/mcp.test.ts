import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mcpBoot, oauthGrant } from './mcp-helpers.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { transactions } from '../src/db/schema.js';

function decoded(res: request.Response) {
  if (res.body?.jsonrpc) return res.body;
  const message = res.text.split('\n').find((l) => l.startsWith('data: '));
  return message ? JSON.parse(message.slice(6)) : res.body;
}
async function rpc(
  app: Awaited<ReturnType<typeof mcpBoot>>['app'],
  token: string,
  method: string,
  params: unknown = {},
) {
  const res = await request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .set('MCP-Protocol-Version', '2025-11-25')
    .send({ jsonrpc: '2.0', id: 1, method, params });
  return { status: res.status, body: decoded(res) };
}

describe('remote Moaney MCP', () => {
  it('challenges missing credentials and rejects browser origins outside Moaney', async () => {
    const { app } = await mcpBoot();
    const missing = await request(app).post('/mcp').send({});
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toContain('oauth-protected-resource/mcp');
    const grant = await oauthGrant(app);
    expect(
      (
        await request(app)
          .post('/mcp')
          .set('Authorization', `Bearer ${grant.tokens.access_token}`)
          .set('Origin', 'https://evil.example')
          .send({})
      ).status,
    ).toBe(403);
  });
  it('negotiates the protocol and lists all finance capabilities with accurate write hints', async () => {
    const { app } = await mcpBoot(),
      { tokens } = await oauthGrant(app);
    const init = await rpc(app, tokens.access_token, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1' },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe('moaney');
    const list = await rpc(app, tokens.access_token, 'tools/list');
    const tools = list.body.result.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'get_context',
        'list_transactions',
        'get_transaction',
        'find_duplicates',
        'get_report',
        'compare_reports',
        'list_bills',
        'list_goals',
        'get_portfolio',
        'get_holding',
        'list_capture_review',
        'list_rules',
        'get_audit_history',
        'preview_changes',
        'commit_changes',
      ]),
    );
    expect(tools.find((t) => t.name === 'commit_changes')?.annotations.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === 'list_transactions')?.annotations.readOnlyHint).toBe(true);
  });
  it('reads real categories and wallets, previews a purchase and saves the exact approved draft', async () => {
    const { app, handle } = await mcpBoot(),
      { tokens } = await oauthGrant(app);
    const context = await rpc(app, tokens.access_token, 'tools/call', { name: 'get_context', arguments: {} });
    expect(context.body.result.structuredContent).toMatchObject({ currency: 'IDR', moneyExponent: 2 });
    expect(
      context.body.result.structuredContent.data.wallets.some((w: { name: string }) => w.name === 'Cash'),
    ).toBe(true);
    const preview = await rpc(app, tokens.access_token, 'tools/call', {
      name: 'preview_changes',
      arguments: {
        operations: [
          {
            op: 'transaction.create',
            entry: {
              type: 'expense',
              amountRupiah: '34190',
              walletId: handle.w('Cash'),
              categoryId: handle.c('Family Bill'),
              occurredAt: '2026-10-01T22:06:00+07:00',
              description: 'Kingwon stop kontak',
              externalId: 'shopee-kingwon',
            },
          },
        ],
      },
    });
    expect(preview.body.result.isError).not.toBe(true);
    const draft = preview.body.result.structuredContent.data;
    expect(handle.db.select().from(transactions).all()).toHaveLength(0);
    const commit = await rpc(app, tokens.access_token, 'tools/call', {
      name: 'commit_changes',
      arguments: { draftId: draft.draftId, digest: draft.digest, approved: true },
    });
    expect(commit.body.result.isError).not.toBe(true);
    const saved = handle.db.select().from(transactions).get()!;
    expect(saved).toMatchObject({
      amount: 3419000,
      source: 'mcp',
      categoryId: handle.c('Family Bill'),
      localDate: '2026-10-01',
    });
    const repeated = await rpc(app, tokens.access_token, 'tools/call', {
      name: 'commit_changes',
      arguments: { draftId: draft.draftId, digest: draft.digest, approved: true },
    });
    expect(repeated.body.result.structuredContent.data).toEqual(commit.body.result.structuredContent.data);
    const found = await rpc(app, tokens.access_token, 'tools/call', {
      name: 'list_transactions',
      arguments: { q: 'stop kontak', from: '2026-10-01', to: '2026-10-01' },
    });
    expect(found.body.result.structuredContent.data.items).toHaveLength(1);
    const detail = await rpc(app, tokens.access_token, 'tools/call', {
      name: 'get_transaction',
      arguments: { id: saved.id },
    });
    expect(detail.body.result.structuredContent.data.history[0].actor).toMatch(/^mcp:/);
    const duplicates = await rpc(app, tokens.access_token, 'tools/call', {
      name: 'find_duplicates',
      arguments: {
        entries: [
          {
            amountRupiah: '34190',
            date: '2026-10-01',
            walletId: handle.w('Cash'),
            externalId: 'shopee-kingwon',
          },
        ],
      },
    });
    expect(duplicates.body.result.structuredContent.data[0].exact[0].id).toBe(saved.id);
  });
  it('denies read-only writes, rejects unapproved calls and invalid arguments without ledger changes', async () => {
    const { app, handle } = await mcpBoot(),
      { tokens } = await oauthGrant(app, 'moaney:read');
    const list = await rpc(app, tokens.access_token, 'tools/list');
    expect(list.body.result.tools.some((t: { name: string }) => t.name === 'commit_changes')).toBe(false);
    const rejected = await rpc(app, tokens.access_token, 'tools/call', {
      name: 'preview_changes',
      arguments: { operations: [] },
    });
    expect(rejected.body.error || rejected.body.result?.isError).toBeTruthy();
    const { tokens: write } = await oauthGrant(app);
    const noApproval = await rpc(app, write.access_token, 'tools/call', {
      name: 'commit_changes',
      arguments: { draftId: 'x', digest: 'x', approved: false },
    });
    expect(noApproval.body.error || noApproval.body.result?.isError).toBeTruthy();
    expect(handle.db.select().from(transactions).all()).toHaveLength(0);
  });
  it('immediately rejects revoked grants and keeps existing cookie endpoints protected', async () => {
    const { app, handle } = await mcpBoot(),
      grant = await oauthGrant(app);
    await request(app)
      .post('/oauth/revoke')
      .type('form')
      .send({ client_id: grant.clientId, token: grant.tokens.refresh_token });
    expect((await rpc(app, grant.tokens.access_token, 'tools/list')).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/v1/transactions')
          .set('Authorization', `Bearer ${grant.tokens.access_token}`)
          .send({})
      ).status,
    ).toBe(401);
    expect(handle.db.select().from(transactions).where(eq(transactions.source, 'mcp')).all()).toHaveLength(0);
  });

  it('accepts a standard SDK client over real HTTP and executes the advertised schemas', async () => {
    const { app } = await mcpBoot(),
      grant = await oauthGrant(app);
    const http = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => http.once('listening', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const client = new Client({ name: 'standard-mcp-client', version: '1' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${grant.tokens.access_token}` } },
        }),
      );
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === 'preview_changes')).toBe(true);
      const read = await client.callTool({ name: 'get_context', arguments: {} });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({ currency: 'IDR', moneyExponent: 2 });
    } finally {
      await client.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it('bounds MCP request bodies before parsing the ordinary large CSV payload limit', async () => {
    const { app } = await mcpBoot();
    expect(
      (
        await request(app)
          .post('/mcp')
          .send({ padding: 'x'.repeat(1024 * 1024 + 1) })
      ).status,
    ).toBe(413);
  });
});
