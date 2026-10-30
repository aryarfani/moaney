import os from 'node:os';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/auth.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { parseMoneyText, parseNotification } from '../src/domain/capture.js';

let hash: string;
beforeAll(async () => {
  hash = await hashPassword('correct horse battery');
});

const GOPAY = 'Transfer berhasil: Rp10.000 udah dikirim ke BCA A RIFQI YARZUQ ARFANI.';
const MYBCA = 'You received IDR 10,000.00 from ***PET **AK ***GSA';
const T0 = Date.parse('2026-10-30T03:25:00Z'); // 10:25 Jakarta

interface Item {
  id: number;
  kind: string;
  type: string;
  amount: number;
  walletId: number;
  toWalletId: number | null;
  categoryId: number | null;
  description: string;
  billName: string | null;
  other: { appLabel: string } | null;
}

async function boot() {
  const handle = openDb(':memory:');
  seed(handle.db);
  const app = createApp(handle, loadConfig({ OWNER_PASSWORD_HASH: hash } as NodeJS.ProcessEnv), os.tmpdir());
  const agent = request.agent(app);
  const login = await agent.post('/api/v1/auth/login').send({ password: 'correct horse battery' });
  const csrf = login.body.csrf as string;
  const post = (url: string, body: unknown = {}) => agent.post(url).set('x-csrf-token', csrf).send(body as object);
  const device = await post('/api/v1/capture/device', { name: 'Test phone' });
  const token = device.body.token as string;
  const send = (appName: string, text: string, minutes = 0, title?: string) =>
    request(app).post('/api/v1/capture/notifications').set('authorization', `Bearer ${token}`)
      .send({ app: appName, text, title, postedAt: T0 + minutes * 60_000 });
  const pending = async () => (await agent.get('/api/v1/capture/pending')).body as { items: Item[]; count: number };
  const cat = (name: string) => handle.raw.prepare('select id from categories where name = ?').get(name) as { id: number };
  const wallet = (name: string) => handle.raw.prepare('select id from wallets where name = ?').get(name) as { id: number };
  return { app, agent, post, send, pending, token, handle, cat, wallet, csrf };
}

describe('notification parsing', () => {
  it('reads amounts in both Indonesian and English formats', () => {
    expect(parseMoneyText('10.000')).toBe(1_000_000);
    expect(parseMoneyText('10,000.00')).toBe(1_000_000);
    expect(parseMoneyText('47.000.')).toBe(4_700_000);
    expect(parseMoneyText('1.250.000,50')).toBe(125_000_050);
    expect(parseMoneyText('abc')).toBeNull();
  });
  it('parses the real GoPay and myBCA samples', () => {
    expect(parseNotification(GOPAY)).toEqual({ amount: 1_000_000, direction: 'out', counterpart: 'BCA A RIFQI YARZUQ ARFANI' });
    expect(parseNotification(MYBCA)).toEqual({ amount: 1_000_000, direction: 'in', counterpart: '***PET **AK ***GSA' });
  });
  it('handles generic payments, top ups and unreadable text', () => {
    expect(parseNotification('Pembayaran Rp47.000 ke GrabCar berhasil')).toEqual({ amount: 4_700_000, direction: 'out', counterpart: 'GrabCar' });
    expect(parseNotification('Top up berhasil Rp100.000').direction).toBe('in');
    expect(parseNotification('Selamat datang').amount).toBeNull();
  });
});

describe('capture ingest', () => {
  it('rejects a missing or wrong device token', async () => {
    const { app } = await boot();
    expect((await request(app).post('/api/v1/capture/notifications').send({ app: 'gopay', text: GOPAY })).status).toBe(401);
    expect((await request(app).post('/api/v1/capture/notifications').set('authorization', 'Bearer nope').send({ app: 'gopay', text: GOPAY })).status).toBe(401);
  });

  it('drops OTPs and security messages without storing them', async () => {
    const { send, pending, handle } = await boot();
    const r = await send('mybca', 'Kode OTP Anda 123456. Jangan berikan kepada siapapun.');
    expect(r.status).toBe(202);
    expect(r.body.dropped).toBe('security');
    expect((await pending()).count).toBe(0);
    expect((handle.raw.prepare('select count(*) n from notifications').get() as { n: number }).n).toBe(0);
  });

  it('accepts package-style app names and rejects unknown apps', async () => {
    const { send } = await boot();
    expect((await send('com.gojek.gopay', GOPAY)).status).toBe(201);
    expect((await send('com.example.chat', GOPAY)).status).toBe(400);
  });

  it('ignores an exact retry of the same notification', async () => {
    const { send, pending } = await boot();
    await send('gopay', GOPAY);
    await send('gopay', GOPAY);
    expect((await pending()).count).toBe(1);
  });

  it('pairs a GoPay send and a BCA receive into one transfer and confirms it once', async () => {
    const { send, pending, post, agent, wallet } = await boot();
    await send('gopay', GOPAY, 0);
    await send('mybca', MYBCA, 1);
    const { items, count } = await pending();
    expect(count).toBe(1);
    expect(items[0]).toMatchObject({ kind: 'paired_transfer', type: 'transfer', amount: 1_000_000, walletId: wallet('GoPay').id, toWalletId: wallet('BCA').id });
    expect(items[0]!.other?.appLabel).toBe('myBCA');

    const done = await post(`/api/v1/capture/${items[0]!.id}/confirm`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ type: 'transfer', source: 'notification', amount: 1_000_000 });
    expect((await pending()).count).toBe(0);

    const ws = (await agent.get('/api/v1/wallets')).body as { name: string; balance: number }[];
    expect(ws.find((w) => w.name === 'GoPay')!.balance).toBe(-1_000_000);
    expect(ws.find((w) => w.name === 'BCA')!.balance).toBe(1_000_000);
    expect((await post(`/api/v1/capture/${items[0]!.id}/confirm`)).status).toBe(409);
  });

  it('treats a payment to one of your own names as a transfer that needs a destination only if it cannot find one', async () => {
    const { send, pending, post } = await boot();
    await send('gopay', GOPAY);
    const { items } = await pending();
    expect(items[0]).toMatchObject({ kind: 'own_transfer', type: 'transfer' });
    // "BCA" in the wording points at the BCA wallet, so it can be confirmed on its own.
    expect((await post(`/api/v1/capture/${items[0]!.id}/confirm`)).status).toBe(200);
  });

  it('flags the same payment arriving twice within minutes and offers keep one / both', async () => {
    const { send, pending, post, cat, agent } = await boot();
    const pay = 'Pembayaran Rp28.000 ke Kopi Kenangan berhasil';
    await send('gopay', pay, 0);
    await send('gopay', pay, 4);
    const first = await pending();
    expect(first.count).toBe(1);
    expect(first.items[0]).toMatchObject({ kind: 'possible_duplicate', amount: 2_800_000 });
    expect(first.items[0]!.other).toBeTruthy();

    const kept = await post(`/api/v1/capture/${first.items[0]!.id}/keep-one`);
    expect(kept.status).toBe(200);
    expect((await pending()).count).toBe(0);
    const txns = (await agent.get('/api/v1/transactions')).body as unknown[];
    expect(txns).toHaveLength(1);
    expect(cat('Others').id).toBeGreaterThan(0);

    await send('gopay', 'Pembayaran Rp15.000 ke Warung X berhasil', 10);
    await send('gopay', 'Pembayaran Rp15.000 ke Warung X berhasil', 12);
    const dup = (await pending()).items[0]!;
    expect((await post(`/api/v1/capture/${dup.id}/keep-both`)).status).toBe(200);
    expect((await pending()).count).toBe(2);
  });

  it('suggests a category, learns from confirmations and proposes a rule after three', async () => {
    const { send, pending, post, cat, agent } = await boot();
    const transport = cat('Household').id;
    for (let i = 0; i < 3; i++) {
      await send('gopay', `Pembayaran Rp${40 + i}.000 ke GrabCar berhasil`, i * 60);
      const item = (await pending()).items[0]!;
      // First time it falls back to Others; afterwards history already points at the chosen category.
      expect(item.categoryId).toBe(i === 0 ? cat('Others').id : transport);
      expect((await post(`/api/v1/capture/${item.id}/confirm`, { categoryId: transport })).status).toBe(200);
    }
    const rules = (await agent.get('/api/v1/rules')).body as { suggested: { id: number; pattern: string; chosen: number }[] };
    expect(rules.suggested).toHaveLength(1);
    expect(rules.suggested[0]).toMatchObject({ pattern: 'grabcar', chosen: 3 });

    await post(`/api/v1/rules/${rules.suggested[0]!.id}/approve`);
    await send('gopay', 'Pembayaran Rp55.000 ke GrabCar berhasil', 600);
    expect((await pending()).items[0]!.categoryId).toBe(transport);
  });

  it('matches a bill by amount and wallet, uses its category and advances it when confirmed', async () => {
    const { send, pending, post, handle, cat, wallet, agent } = await boot();
    handle.raw.prepare('insert into bills (name, amount, wallet_id, category_id, next_due) values (?, ?, ?, ?, ?)')
      .run('Internet', 35_000_000, wallet('GoPay').id, cat('Family Bill').id, '2026-11-02');
    await send('gopay', 'Pembayaran Rp350.000 ke IndiHome berhasil');
    const item = (await pending()).items[0]!;
    expect(item).toMatchObject({ billName: 'Internet', categoryId: cat('Family Bill').id, description: 'Internet' });
    await post(`/api/v1/capture/${item.id}/confirm`);
    expect((handle.raw.prepare('select next_due d from bills').get() as { d: string }).d).toBe('2026-12-02');
    expect(((await agent.get('/api/v1/transactions')).body as { description: string }[])[0]!.description).toBe('Internet');
  });

  it('lets the owner edit before confirming, dismiss, and close the day', async () => {
    const { send, pending, post, cat, wallet } = await boot();
    await send('mybca', 'Selamat datang di myBCA'); // unreadable
    await send('gopay', 'Pembayaran Rp20.000 ke Toko A berhasil', 1);
    await send('gopay', 'Pembayaran Rp30.000 ke Toko B berhasil', 2);
    let { items } = await pending();
    expect(items.find((i) => i.kind === 'unreadable')).toBeTruthy();
    const unreadable = items.find((i) => i.kind === 'unreadable')!;
    expect((await post(`/api/v1/capture/${unreadable.id}/confirm`)).status).toBe(400);

    const edited = await post(`/api/v1/capture/${unreadable.id}/edit-confirm`, {
      type: 'expense', amount: 1_200_000, walletId: wallet('BCA').id, categoryId: cat('My Food').id, description: 'Lunch', occurredAt: '2026-10-30',
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ source: 'notification', description: 'Lunch' });

    const toko = (await pending()).items.find((i) => i.description === 'Toko A')!;
    expect((await post(`/api/v1/capture/${toko.id}/dismiss`)).status).toBe(200);

    const closed = await post('/api/v1/capture/close-day');
    expect(closed.body).toEqual({ confirmed: 1, left: 0 });
    items = (await pending()).items;
    expect(items).toHaveLength(0);
  });

  it('accepts but does not store anything while capture is paused, and remembers the setting', async () => {
    const { agent, csrf, send, pending } = await boot();
    const put = await agent.put('/api/v1/capture/settings').set('x-csrf-token', csrf).send({ paused: true });
    expect(put.body.paused).toBe(true);
    const r = await send('gopay', GOPAY);
    expect(r.status).toBe(202);
    expect(r.body.paused).toBe(true);
    expect((await pending()).count).toBe(0);
  });

  it('manages names, wallet mapping, devices and the sources summary', async () => {
    const { agent, csrf, post, send, token } = await boot();
    const names = await agent.put('/api/v1/capture/settings').set('x-csrf-token', csrf).send({ addName: 'rifqi' });
    expect(names.body.names).toContain('RIFQI');
    await send('gopay', GOPAY);
    const view = (await agent.get('/api/v1/capture/sources')).body as { apps: { id: number; app: string; hasParser: boolean; total: number }[]; devices: { id: number; lastSeenAt: string }[]; lastNotificationAt: string };
    expect(view.apps.map((a) => a.app)).toEqual(['gopay', 'mybca', 'jago']);
    expect(view.apps.find((a) => a.app === 'gopay')!.total).toBe(1);
    expect(view.apps.find((a) => a.app === 'jago')!.hasParser).toBe(false);
    expect(view.devices[0]!.lastSeenAt).toBeTruthy();
    expect(JSON.stringify(view)).not.toContain(token);

    const gone = await agent.delete(`/api/v1/capture/device/${view.devices[0]!.id}`).set('x-csrf-token', csrf);
    expect(gone.status).toBe(200);
    expect((await send('gopay', GOPAY, 5)).status).toBe(401);
    expect((await post('/api/v1/capture/device', { name: 'Again' })).body.token).toBeTruthy();
  });

  it('blanks the original wording of reviewed notifications after the retention window', async () => {
    const { send, pending, post, handle, agent, csrf } = await boot();
    await send('gopay', 'Pembayaran Rp20.000 ke Toko A berhasil');
    await post(`/api/v1/capture/${(await pending()).items[0]!.id}/confirm`);
    handle.raw.prepare("update notifications set created_at = '2020-01-01T00:00:00Z'").run();
    await agent.put('/api/v1/capture/settings').set('x-csrf-token', csrf).send({ retentionDays: 7 });
    await send('gopay', 'Pembayaran Rp21.000 ke Toko B berhasil', 30);
    const rows = handle.raw.prepare('select status, text from notifications order by id').all() as { status: string; text: string }[];
    expect(rows[0]).toEqual({ status: 'confirmed', text: '' });
    expect(rows[1]!.text).toContain('Toko B');
  });
});

import { parseBody } from '../src/routes/capture-ingest.js';

describe('ingest body parsing', () => {
  it('accepts valid JSON, form encoding and JSON broken by quotes in the text', () => {
    expect(parseBody('{"app":"gopay","text":"Rp10.000"}')).toMatchObject({ app: 'gopay', text: 'Rp10.000' });
    expect(parseBody('app=gopay&title=Hi&text=Rp10.000+masuk')).toMatchObject({ app: 'gopay', text: 'Rp10.000 masuk' });
    expect(parseBody('{"app":"gopay","title":"GoPay","text":"Kamu "bayar" Rp47.000 ke GrabCar"}')).toMatchObject({ app: 'gopay', text: 'Kamu "bayar" Rp47.000 ke GrabCar' });
  });
});
