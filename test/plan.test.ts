import os from 'node:os';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/auth.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { addMonths, monthlyNeeded } from '../src/domain/plan.js';

let hash: string;
beforeAll(async () => {
  hash = await hashPassword('correct horse battery');
});

async function boot() {
  const handle = openDb(':memory:');
  seed(handle.db);
  const app = createApp(handle, loadConfig({ OWNER_PASSWORD_HASH: hash } as NodeJS.ProcessEnv), os.tmpdir());
  const agent = request.agent(app);
  const csrf = (await agent.post('/api/v1/auth/login').send({ password: 'correct horse battery' })).body.csrf as string;
  const send = (m: 'post' | 'patch' | 'put', url: string, body?: unknown) => agent[m](url).set('x-csrf-token', csrf).send((body ?? {}) as object);
  const wallets = (await agent.get('/api/v1/wallets')).body as { id: number; name: string }[];
  const cats = (await agent.get('/api/v1/categories')).body as { id: number; name: string }[];
  const w = (n: string) => wallets.find((x) => x.name === n)!.id;
  const c = (n: string) => cats.find((x) => x.name === n)!.id;
  return { agent, send, w, c };
}

describe('plan helpers', () => {
  it('addMonths clamps to the end of shorter months', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-12-05', 1)).toBe('2027-01-05');
  });
  it('monthlyNeeded divides what is left over the months to the due date', () => {
    expect(monthlyNeeded(800_000_000, 120_000_000, '2027-04-30', '2026-10-30')).toBe(Math.ceil(680_000_000 / 6));
    expect(monthlyNeeded(100, 100, '2027-01-01', '2026-10-30')).toBeNull();
    expect(monthlyNeeded(100, 0, null)).toBeNull();
  });
});

describe('plan API', () => {
  it('goals: create, add money, archive', async () => {
    const { agent, send } = await boot();
    const g = (await send('post', '/api/v1/goals', { name: 'Bali trip', target: 800_000_000, dueDate: '2027-04-30' })).body;
    expect(g.saved).toBe(0);
    expect((await send('post', `/api/v1/goals/${g.id}/add`, { amount: 120_000_000 })).body.saved).toBe(120_000_000);
    expect((await send('post', `/api/v1/goals/${g.id}/add`, { amount: -5 })).status).toBe(400);
    const summary = (await agent.get('/api/v1/settings/summary')).body;
    expect(summary.goals).toEqual({ count: 1, saved: 120_000_000 });
    await send('patch', `/api/v1/goals/${g.id}`, { archived: true });
    expect((await agent.get('/api/v1/goals')).body).toHaveLength(0);
  });

  it('bills: paying creates one expense and moves the due date a month on', async () => {
    const { agent, send, w, c } = await boot();
    const b = (await send('post', '/api/v1/bills', { name: 'Electricity', amount: 48_600_000, walletId: w('BCA'), categoryId: c('Household'), nextDue: '2026-10-31' })).body;
    const paid = (await send('post', `/api/v1/bills/${b.id}/pay`)).body;
    expect(paid.bill.nextDue).toBe('2026-11-30');
    expect(paid.transaction).toMatchObject({ type: 'expense', amount: 48_600_000, description: 'Electricity', walletId: w('BCA') });
    const wallet = (await agent.get(`/api/v1/wallets/${w('BCA')}/detail`)).body;
    expect(wallet.wallet.balance).toBe(-48_600_000);
    expect(wallet.recent).toHaveLength(1);
    expect((await send('post', '/api/v1/bills', { name: 'X', amount: 1, walletId: w('BCA'), categoryId: c('Salary'), nextDue: '2026-11-01' })).status).toBe(400);
    expect((await agent.get('/api/v1/settings/summary')).body.bills.count).toBe(1);
  });

  it('categories overview sums this month per category and carries budgets', async () => {
    const { agent, send, w, c } = await boot();
    await send('patch', `/api/v1/categories/${c('My Food')}`, { monthlyBudget: 250_000_000 });
    await send('post', '/api/v1/transactions', { type: 'expense', amount: 1_600_000, walletId: w('Cash'), categoryId: c('My Food'), occurredAt: '2026-10-05' });
    await send('post', '/api/v1/transactions', { type: 'expense', amount: 400_000, walletId: w('Cash'), categoryId: c('My Food'), occurredAt: '2026-09-30' });
    const rows = (await agent.get('/api/v1/categories/overview?month=2026-10')).body as { id: number; spent: number; budget: number | null }[];
    expect(rows.find((r) => r.id === c('My Food'))).toEqual({ id: c('My Food'), spent: 1_600_000, budget: 250_000_000 });
    expect(rows.find((r) => r.id === c('Others'))!.spent).toBe(0);
    expect((await agent.get('/api/v1/categories/overview?month=2026-13')).status).toBe(400);
  });

  it('settings values accept only known keys and values', async () => {
    const { agent, send } = await boot();
    expect((await agent.get('/api/v1/settings/values')).body).toEqual({ 'bills.autoMatch': 'true', 'capture.retentionDays': '30' });
    expect((await send('put', '/api/v1/settings/values/capture.retentionDays', { value: '90' })).status).toBe(200);
    expect((await send('put', '/api/v1/settings/values/capture.retentionDays', { value: '5' })).status).toBe(400);
    expect((await send('put', '/api/v1/settings/values/nope', { value: 'x' })).status).toBe(404);
    expect((await agent.get('/api/v1/data/status')).body.retentionDays).toBe(90);
  });
});
