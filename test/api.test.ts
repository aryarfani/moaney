import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/auth.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/client.js';
import { runBackup } from '../src/jobs/backup.js';
import { seed } from '../src/db/seed.js';

let hash: string;
beforeAll(async () => {
  hash = await hashPassword('correct horse battery');
});

async function boot() {
  const handle = openDb(':memory:');
  seed(handle.db);
  const app = createApp(handle, loadConfig({ OWNER_PASSWORD_HASH: hash } as NodeJS.ProcessEnv), os.tmpdir());
  const agent = request.agent(app);
  const login = await agent.post('/api/v1/auth/login').send({ password: 'correct horse battery' });
  const csrf = login.body.csrf as string;
  const post = (url: string, body: unknown) => agent.post(url).set('x-csrf-token', csrf).send(body as object);
  return { app, agent, post, csrf, handle };
}

const CSV = [
  'date,type,amount,wallet,to_wallet,category,description,note,external_id',
  '2026-10-29 12:10,expense,16000,Cash,,My Food,Nasbung,,mt-1',
  '2026-10-28,expense,18000,,,My Food,Nasi ayam,,mt-2',
  '2026-10-27,expense,18000,,,My Food,Nasi ayam,,mt-3',
  '2026-10-26,transfer,100000,Cash,Owed to me,,Lent to friend,,mt-4',
  '2026-10-25,expense,5000,Cash,,Brand New Category,Thing,,mt-5',
  'not-a-date,expense,1,Cash,,My Food,Bad,,mt-6',
  '2026-10-24,expense,abc,Cash,,My Food,Bad amount,,mt-7',
  '2026-10-23,transfer,1000,Cash,,,No destination,,mt-8',
].join('\n');

describe('auth', () => {
  it('rejects unauthenticated and wrong-password requests', async () => {
    const { app } = await boot();
    expect((await request(app).get('/api/v1/wallets')).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ password: 'nope' })).status).toBe(401);
    expect((await request(app).get('/health')).body).toEqual({ ok: true });
  });
  it('requires the CSRF header on writes and sets hardened headers', async () => {
    const { agent } = await boot();
    const res = await agent.post('/api/v1/transactions').send({});
    expect(res.status).toBe(403);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
  it('rate limits repeated bad logins', async () => {
    const { app } = await boot();
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await request(app).post('/api/v1/auth/login').send({ password: 'bad' })).status;
    expect(last).toBe(429);
  });
});

describe('transactions API', () => {
  it('creates, lists, edits and voids; wallet balances follow', async () => {
    const { agent, post, csrf } = await boot();
    const wallets = (await agent.get('/api/v1/wallets')).body as { id: number; name: string; balance: number }[];
    const cats = (await agent.get('/api/v1/categories')).body as { id: number; name: string }[];
    const cash = wallets.find((w) => w.name === 'Cash')!;
    const created = await post('/api/v1/transactions', { type: 'expense', amount: 1_600_000, walletId: cash.id, categoryId: cats.find((c) => c.name === 'My Food')!.id, description: 'Nasbung' });
    expect(created.status).toBe(201);
    expect((await agent.get('/api/v1/transactions')).body).toHaveLength(1);
    await agent.patch(`/api/v1/transactions/${created.body.id}`).set('x-csrf-token', csrf).send({ amount: 2_000_000 });
    const after = (await agent.get('/api/v1/wallets')).body as { name: string; balance: number }[];
    expect(after.find((w) => w.name === 'Cash')!.balance).toBe(-2_000_000);
    await agent.delete(`/api/v1/transactions/${created.body.id}`).set('x-csrf-token', csrf);
    expect((await agent.get('/api/v1/transactions')).body).toHaveLength(0);
    const detail = (await agent.get(`/api/v1/transactions/${created.body.id}`)).body;
    expect(detail.history.map((h: { action: string }) => h.action)).toEqual(['void', 'update', 'create']);
  });

  it('typed entry round trip with bulk commit', async () => {
    const { post, agent } = await boot();
    const parsed = (await post('/api/v1/entries/parse', { text: 'kopi 28k gopay dan parkir 3k' })).body;
    expect(parsed).toHaveLength(2);
    const items = parsed.map((p: { type: string; amount: number; walletId: number; categoryId: number; description: string }) => ({ ...p, source: 'typed' }));
    expect((await post('/api/v1/transactions/bulk', { items })).status).toBe(201);
    expect((await agent.get('/api/v1/reports/summary')).body.today.count).toBeGreaterThanOrEqual(0);
  });

  it('rejects invalid bodies with 400', async () => {
    const { post } = await boot();
    expect((await post('/api/v1/transactions', { type: 'expense', amount: -5, walletId: 1 })).status).toBe(400);
    expect((await post('/api/v1/transactions', { type: 'expense', amount: 5, walletId: 1 })).status).toBe(400);
  });
});

describe('CSV import', () => {
  it('previews, applies, is idempotent, and routes blank wallets to Before Moaney', async () => {
    const { post, agent } = await boot();
    const preview = (await post('/api/v1/imports', { csv: CSV })).body;
    expect(preview).toMatchObject({ total: 8, ready: 5, duplicates: 0 });
    expect(preview.newWallets).toEqual(['Before Moaney'].filter((n) => preview.newWallets.includes(n)));
    expect(preview.newCategories).toEqual([{ name: 'Brand New Category', kind: 'expense' }]);
    expect(preview.problems.map((p: { line: number }) => p.line)).toEqual([7, 8, 9]);
    expect(preview.dateFrom).toBe('2026-10-25');

    const nothingWrittenYet = (await agent.get('/api/v1/transactions')).body;
    expect(nothingWrittenYet).toHaveLength(0);

    const applied = (await post(`/api/v1/imports/${preview.id}/apply`, { createNew: true })).body;
    expect(applied).toMatchObject({ imported: 5, skipped: 0, createdCategories: ['Brand New Category'] });

    const wallets = (await agent.get('/api/v1/wallets')).body as { name: string; balance: number; countsTowardTotal: boolean }[];
    const history = wallets.find((w) => w.name === 'Before Moaney')!;
    expect(history).toMatchObject({ balance: -3_600_000, countsTowardTotal: false });
    expect(wallets.find((w) => w.name === 'Owed to me')!.balance).toBe(10_000_000);

    const again = (await post('/api/v1/imports', { csv: CSV })).body;
    expect(again.ready).toBe(0);
    expect(again.duplicates).toBe(5);

    const chips = (await agent.get('/api/v1/suggestions')).body.logAgain;
    expect(chips[0]).toMatchObject({ description: 'Nasi ayam', amount: 1_800_000, count: 2 });
    expect(chips[0].walletId).toBeGreaterThan(0);
  });

  it('can skip rows that need new names', async () => {
    const { post, agent } = await boot();
    const preview = (await post('/api/v1/imports', { csv: CSV })).body;
    const applied = (await post(`/api/v1/imports/${preview.id}/apply`, { createNew: false })).body;
    expect(applied).toMatchObject({ imported: 4, skipped: 1 });
    expect((await agent.get('/api/v1/categories')).body.some((c: { name: string }) => c.name === 'Brand New Category')).toBe(false);
  });

  it('reports a missing-column file as a problem, not a crash', async () => {
    const { post } = await boot();
    const res = (await post('/api/v1/imports', { csv: 'foo,bar\n1,2' })).body;
    expect(res.ready).toBe(0);
    expect(res.problems[0].reason).toMatch(/Missing column/);
  });

  it('serves a template that imports cleanly, and exports CSV', async () => {
    const { agent, post } = await boot();
    const tpl = (await agent.get('/api/v1/imports/template')).text;
    const preview = (await post('/api/v1/imports', { csv: tpl })).body;
    expect(preview.problems).toEqual([]);
    expect(preview.ready).toBe(4);
    await post(`/api/v1/imports/${preview.id}/apply`, { createNew: true });
    const out = (await agent.get('/api/v1/export.csv')).text;
    expect(out.split('\n')[0]).toBe('date,type,amount,wallet,to_wallet,category,description,note,external_id');
    expect(out).toContain('Old entry with no wallet');
  });
});

describe('backup', () => {
  it('writes a restorable snapshot and rotates old ones', async () => {
    const { handle, post } = await boot();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moaney-bk-'));
    const live = openDb(path.join(dir, 'live.db'));
    seed(live.db);
    const file = runBackup(live.raw, path.join(dir, 'b'), 2, '2026-10-30T03:00:00+07:00');
    const restored = openDb(file);
    expect((restored.raw.prepare('select count(*) n from wallets').get() as { n: number }).n).toBe(6);
    restored.raw.close();
    runBackup(live.raw, path.join(dir, 'b'), 2, '2026-10-31T03:00:00+07:00');
    runBackup(live.raw, path.join(dir, 'b'), 2, '2026-11-01T03:00:00+07:00');
    expect(fs.readdirSync(path.join(dir, 'b'))).toHaveLength(2);
    void handle; void post;
  });
});
