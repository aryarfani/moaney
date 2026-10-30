import { and, desc, eq, inArray, lt, ne } from 'drizzle-orm';
import type { TransactionInput } from '../../shared/schemas.js';
import type { Db } from '../db/client.js';
import { bills, captureSources, categories, notifications, rules, settings, transactions, wallets } from '../db/schema.js';
import { categoryByDescription } from './insights.js';
import { createTransaction, LedgerError } from './ledger.js';
import { addDays, jakartaNow } from './time.js';

export const APPS = { gopay: 'GoPay', mybca: 'myBCA', jago: 'Jago' } as const;
export type AppKey = keyof typeof APPS;

export const DEFAULT_NAMES = ['A RIFQI YARZUQ ARFANI'];
const PAIR_WINDOW_MS = 15 * 60_000;
const DUP_WINDOW_MS = 5 * 60_000;

// ---- settings

export function getSetting(db: Db, key: string): string | undefined {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}
export function setSetting(db: Db, key: string, value: string): void {
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}
export function ownNames(db: Db): string[] {
  try {
    const v = JSON.parse(getSetting(db, 'capture.names') ?? 'null') as unknown;
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  } catch { /* fall through */ }
  return DEFAULT_NAMES;
}
export const retentionDays = (db: Db) => Number(getSetting(db, 'capture.retentionDays') ?? 30) || 30;

// ---- parsing

export function normaliseApp(input: string): AppKey | null {
  const s = input.toLowerCase();
  if (s.includes('gopay') || s.includes('gojek')) return 'gopay';
  if (s.includes('bca')) return 'mybca';
  if (s.includes('jago')) return 'jago';
  return null;
}

/** OTPs, codes and security messages are dropped before anything is stored. */
const SECURITY = /\b(?:kode|otp|verification|verifikasi|jangan (?:berikan|bagikan|beritahukan)|password|kata sandi|pin|one[- ]time|waspada)\b/i;
export const isSecurityText = (s: string) => SECURITY.test(s);

/** "10.000", "10,000.00", "47000" -> minor units (IDR exponent 2). */
export function parseMoneyText(raw: string): number | null {
  const s = raw.replace(/[.,]+$/, '');
  let whole: string;
  let frac = '';
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) [whole = '', frac = ''] = s.replace(/,/g, '').split('.');
  else if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) [whole = '', frac = ''] = s.replace(/\./g, '').split(',');
  else if (/^\d+([.,]\d{1,2})?$/.test(s)) [whole = '', frac = ''] = s.split(/[.,]/);
  else return null;
  const n = Number(whole + frac.padEnd(2, '0'));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const IN = /\b(?:received|diterima|menerima|terima|masuk|cashback|refund|top[- ]?up)\b/i;
const OUT = /\b(?:dikirim|sent|transfer berhasil|pembayaran|payment|paid|dibayar|bayar|debit|purchase|belanja|penarikan|withdraw|transferred)\b/i;

export interface Parsed {
  amount: number | null;
  direction: 'in' | 'out' | null;
  counterpart: string | null;
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').replace(/\s+(?:berhasil|success(?:ful)?)[.\s]*$/i, '').replace(/[.\s]+$/, '').trim() || null;

export function parseNotification(text: string): Parsed {
  const am = /(?:Rp\.?|IDR)\s?(\d[\d.,]*)/i.exec(text);
  const amount = am ? parseMoneyText(am[1]!) : null;
  const inAt = IN.exec(text)?.index ?? Infinity;
  const outAt = OUT.exec(text)?.index ?? Infinity;
  const direction = inAt === Infinity && outAt === Infinity ? null : inAt < outAt ? 'in' : 'out';
  let counterpart: string | null = null;
  if (direction === 'in') {
    const m = /\b(?:from|dari)\s+(.+)$/i.exec(text);
    counterpart = m ? tidy(m[1]!) : null;
  } else if (direction === 'out') {
    const m = /\b(?:dikirim ke|sent to|transfer(?:red)? to|ke|to|at|di)\s+(.+?)(?:\s+(?:dengan|using|with|via|pakai|menggunakan)\b.*)?$/i.exec(text);
    counterpart = m ? tidy(m[1]!) : null;
  }
  return { amount, direction, counterpart };
}

// ---- sources

export function ensureSources(db: Db): void {
  if (db.select().from(captureSources).limit(1).all().length > 0) return;
  const byName = (n: string) => db.select().from(wallets).where(eq(wallets.name, n)).get()?.id ?? null;
  db.insert(captureSources).values([
    { app: 'gopay', label: 'GoPay', walletId: byName('GoPay'), hasParser: true },
    { app: 'mybca', label: 'myBCA', walletId: byName('BCA'), hasParser: true },
    { app: 'jago', label: 'Jago', walletId: byName('Jago'), hasParser: false },
  ]).run();
}

// ---- ingest

type NotifRow = typeof notifications.$inferSelect;

const ms = (iso: string) => Date.parse(iso);

function findWalletInText(db: Db, text: string | null, excludeId?: number | null): number | null {
  if (!text) return null;
  const t = text.toLowerCase();
  const hit = db.select().from(wallets).where(eq(wallets.archived, false)).all()
    .filter((w) => w.kind !== 'history' && w.id !== excludeId && t.includes(w.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];
  return hit?.id ?? null;
}

const isOwn = (db: Db, counterpart: string | null) => {
  if (!counterpart) return false;
  const c = counterpart.toUpperCase();
  return ownNames(db).some((n) => n.trim() && c.includes(n.toUpperCase().trim()));
};

function suggestCategory(db: Db, direction: 'in' | 'out', counterpart: string | null, text: string): { categoryId: number | null; } {
  const kind = direction === 'in' ? 'income' : 'expense';
  const cats = db.select().from(categories).all();
  const ok = (id: number | undefined | null) => (id && cats.find((c) => c.id === id && c.kind === kind && !c.archived) ? id : null);
  const hay = (counterpart ?? text).toLowerCase();
  const rule = db.select().from(rules).where(eq(rules.status, 'active')).all().find((r) => hay.includes(r.pattern));
  const fromRule = ok(rule?.categoryId);
  if (fromRule) return { categoryId: fromRule };
  if (counterpart) {
    const fromHistory = ok(categoryByDescription(db).get(counterpart.toLowerCase().replace(/\s+/g, ' ').trim()));
    if (fromHistory) return { categoryId: fromHistory };
  }
  const fallback = cats.find((c) => c.kind === kind && (kind === 'expense' ? c.name === 'Others' : c.name === 'Other income'));
  return { categoryId: fallback?.id ?? null };
}

function matchBill(db: Db, amount: number, walletId: number | null, receivedAt: string) {
  if (getSetting(db, 'bills.autoMatch') === 'false') return null;
  const horizon = addDays(receivedAt.slice(0, 10), 7);
  return db.select().from(bills).where(eq(bills.active, true)).all()
    .find((b) => b.amount === amount && (!walletId || b.walletId === walletId) && b.nextDue <= horizon) ?? null;
}

export interface IngestInput {
  app: AppKey;
  title?: string;
  text: string;
  receivedAt?: string;
}

/** Deletes the original wording of reviewed notifications once it is older than the retention setting. */
export function purgeOldText(db: Db, nowDate = new Date()): void {
  const cutoff = new Date(nowDate.getTime() - retentionDays(db) * 86400_000).toISOString().slice(0, 19);
  db.update(notifications).set({ text: '' })
    .where(and(ne(notifications.status, 'pending'), ne(notifications.text, ''), lt(notifications.createdAt, cutoff))).run();
}

/** Stores and classifies one captured notification. Returns the row, or null when dropped. */
export function ingest(db: Db, input: IngestInput): NotifRow {
  ensureSources(db);
  const source = db.select().from(captureSources).where(eq(captureSources.app, input.app)).get();
  const receivedAt = input.receivedAt ?? jakartaNow();
  const dupExact = db.select().from(notifications).where(and(eq(notifications.app, input.app), eq(notifications.text, input.text), eq(notifications.receivedAt, receivedAt))).get();
  if (dupExact) return dupExact;

  const p = parseNotification(`${input.title ?? ''} ${input.text}`.trim());
  const walletId = source?.walletId ?? null;
  let kind: string;
  if (!p.amount || !p.direction) kind = 'unreadable';
  else if (isOwn(db, p.counterpart)) kind = 'own_transfer';
  else kind = p.direction === 'out' ? 'new_payment' : 'new_income';

  let pairId: number | null = null;
  let partner: NotifRow | undefined;
  if (p.amount && p.direction) {
    partner = db.select().from(notifications).where(and(eq(notifications.status, 'pending'), eq(notifications.amount, p.amount), eq(notifications.direction, p.direction === 'out' ? 'in' : 'out'))).all()
      .find((n) => n.app !== input.app && n.pairId === null && n.kind !== 'possible_duplicate' && n.kind !== 'unreadable' && Math.abs(ms(n.receivedAt) - ms(receivedAt)) <= PAIR_WINDOW_MS);
    if (partner) {
      kind = 'paired_transfer';
      pairId = partner.id;
    } else {
      const twin = db.select().from(notifications).where(and(eq(notifications.app, input.app), eq(notifications.amount, p.amount), eq(notifications.direction, p.direction), ne(notifications.status, 'dismissed'))).all()
        .find((n) => (n.counterpart ?? '') === (p.counterpart ?? '') && n.kind !== 'paired_transfer' && Math.abs(ms(n.receivedAt) - ms(receivedAt)) <= DUP_WINDOW_MS && n.receivedAt !== receivedAt);
      if (twin) {
        kind = 'possible_duplicate';
        pairId = twin.id;
      }
    }
  }

  let categoryId: number | null = null;
  let billId: number | null = null;
  if (p.amount && p.direction && kind !== 'paired_transfer' && kind !== 'own_transfer') {
    categoryId = suggestCategory(db, p.direction, p.counterpart, input.text).categoryId;
    if (p.direction === 'out') {
      const bill = matchBill(db, p.amount, walletId, receivedAt);
      if (bill) { billId = bill.id; categoryId = bill.categoryId; }
    }
  }

  const row = db.insert(notifications).values({
    app: input.app, text: input.text, receivedAt, status: 'pending', kind, direction: p.direction, amount: p.amount,
    counterpart: p.counterpart, walletId, categoryId, pairId, billId,
  }).returning().get();
  if (partner) db.update(notifications).set({ kind: 'paired_transfer', pairId: row.id }).where(eq(notifications.id, partner.id)).run();

  purgeOldText(db);
  return row;
}

// ---- review queue

export interface ReviewItem {
  id: number;
  kind: string;
  type: 'expense' | 'income' | 'transfer';
  direction: string | null;
  amount: number | null;
  app: string;
  appLabel: string;
  text: string;
  receivedAt: string;
  counterpart: string | null;
  description: string;
  walletId: number | null;
  toWalletId: number | null;
  categoryId: number | null;
  suggestedFrom: number;
  billId: number | null;
  billName: string | null;
  other: { id: number; app: string; appLabel: string; text: string; receivedAt: string; status: string } | null;
}

const label = (app: string) => APPS[app as AppKey] ?? app;

function describe(row: NotifRow, billName: string | null): string {
  if (billName) return billName;
  if (row.kind === 'paired_transfer' || row.kind === 'own_transfer') return 'Transfer';
  if (row.counterpart) return row.direction === 'in' ? `From ${row.counterpart}` : row.counterpart;
  return row.direction === 'in' ? 'Money in' : 'Payment';
}

function buildItem(db: Db, row: NotifRow): ReviewItem {
  const partner = row.pairId ? db.select().from(notifications).where(eq(notifications.id, row.pairId)).get() ?? null : null;
  const bill = row.billId ? db.select().from(bills).where(eq(bills.id, row.billId)).get() : undefined;
  let type: ReviewItem['type'] = row.direction === 'in' ? 'income' : 'expense';
  let walletId = row.walletId;
  let toWalletId: number | null = null;
  if (row.kind === 'paired_transfer' && partner) {
    type = 'transfer';
    const out = row.direction === 'out' ? row : partner;
    const inn = row.direction === 'out' ? partner : row;
    walletId = out.walletId;
    toWalletId = inn.walletId;
  } else if (row.kind === 'own_transfer') {
    type = 'transfer';
    const found = findWalletInText(db, row.counterpart, row.walletId);
    if (row.direction === 'in') {
      walletId = found;
      toWalletId = row.walletId;
    } else {
      toWalletId = found;
    }
  }
  const description = describe(row, bill?.name ?? null);
  const suggestedFrom = type === 'transfer' || !row.counterpart ? 0
    : db.select().from(transactions).where(and(eq(transactions.status, 'posted'), eq(transactions.description, row.counterpart))).all().length;
  const showOther = row.kind === 'possible_duplicate' || row.kind === 'paired_transfer';
  return {
    id: row.id, kind: row.kind ?? 'unreadable', type, direction: row.direction, amount: row.amount, app: row.app, appLabel: label(row.app),
    text: row.text, receivedAt: row.receivedAt, counterpart: row.counterpart, description, walletId, toWalletId,
    categoryId: type === 'transfer' ? null : row.categoryId, suggestedFrom, billId: row.billId, billName: bill?.name ?? null,
    other: showOther && partner ? { id: partner.id, app: partner.app, appLabel: label(partner.app), text: partner.text, receivedAt: partner.receivedAt, status: partner.status } : null,
  };
}

export function listPending(db: Db): ReviewItem[] {
  const rows = db.select().from(notifications).where(eq(notifications.status, 'pending')).orderBy(desc(notifications.receivedAt), desc(notifications.id)).all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hiddenAsOlder = new Set(rows.filter((r) => r.kind === 'possible_duplicate' && r.pairId).map((r) => r.pairId!));
  return rows
    .filter((r) => {
      if (hiddenAsOlder.has(r.id)) return false;
      // A paired transfer shows once, on its outgoing side.
      if (r.kind === 'paired_transfer' && r.direction === 'in' && r.pairId && byId.get(r.pairId)?.direction === 'out') return false;
      return true;
    })
    .map((r) => buildItem(db, r));
}

export const pendingCount = (db: Db) => listPending(db).length;

// ---- confirming

export interface Override {
  categoryId?: number | null;
  walletId?: number | null;
  description?: string;
  amount?: number;
}

function rowsOf(db: Db, row: NotifRow): NotifRow[] {
  const partner = row.kind === 'paired_transfer' && row.pairId ? db.select().from(notifications).where(eq(notifications.id, row.pairId)).get() : undefined;
  return partner ? [row, partner] : [row];
}

function markDone(db: Db, rows: NotifRow[], status: 'confirmed' | 'dismissed', transactionId: number | null): void {
  db.update(notifications).set({ status, transactionId }).where(inArray(notifications.id, rows.map((r) => r.id))).run();
}

function learn(db: Db, item: ReviewItem, categoryId: number): void {
  const pattern = item.counterpart?.toLowerCase().trim();
  if (!pattern || pattern.length < 2 || item.type === 'transfer') return;
  const rule = db.select().from(rules).where(eq(rules.pattern, pattern)).get();
  if (!rule) {
    db.insert(rules).values({ pattern, categoryId, chosen: 1, status: 'pending' }).run();
    return;
  }
  if (rule.status === 'active') {
    if (rule.categoryId === categoryId) db.update(rules).set({ uses: rule.uses + 1 }).where(eq(rules.id, rule.id)).run();
    return;
  }
  if (rule.status === 'off') return;
  const chosen = rule.categoryId === categoryId ? rule.chosen + 1 : 1;
  db.update(rules).set({ categoryId, chosen, status: chosen >= 3 ? 'suggested' : 'pending' }).where(eq(rules.id, rule.id)).run();
}

function advanceBill(db: Db, billId: number | null): void {
  if (!billId) return;
  const bill = db.select().from(bills).where(eq(bills.id, billId)).get();
  if (!bill) return;
  const [y, m, d] = bill.nextDue.split('-').map(Number) as [number, number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const next = `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
  db.update(bills).set({ nextDue: next }).where(eq(bills.id, billId)).run();
}

function pendingRow(db: Db, id: number): NotifRow {
  const row = db.select().from(notifications).where(eq(notifications.id, id)).get();
  if (!row) throw new LedgerError('Notification not found', 404);
  if (row.status !== 'pending') throw new LedgerError('Already reviewed', 409);
  return row;
}

function record(db: Db, row: NotifRow, item: ReviewItem, input: TransactionInput) {
  return db.transaction((tx) => {
    const t = tx as unknown as Db;
    const created = createTransaction(t, input);
    markDone(t, rowsOf(t, row), 'confirmed', created.id);
    if (input.type !== 'transfer' && input.categoryId) learn(t, item, input.categoryId);
    advanceBill(t, row.billId);
    return created;
  });
}

export function confirmNotification(db: Db, id: number, ov: Override = {}) {
  const row = pendingRow(db, id);
  const item = buildItem(db, row);
  if (item.kind === 'unreadable') throw new LedgerError('This one needs details. Open Edit to fill them in.');
  const amount = ov.amount ?? item.amount;
  if (!amount) throw new LedgerError('No amount to record');
  const base = { amount, source: 'notification' as const, externalId: `notif-${row.id}`, occurredAt: row.receivedAt };
  let input: TransactionInput;
  if (item.type === 'transfer') {
    const from = ov.walletId ?? item.walletId;
    if (!from || !item.toWalletId) throw new LedgerError('Pick where this transfer went. Open Edit.');
    input = { ...base, type: 'transfer', walletId: from, toWalletId: item.toWalletId, description: 'Transfer' };
  } else {
    const categoryId = ov.categoryId ?? item.categoryId;
    const walletId = ov.walletId ?? item.walletId;
    if (!walletId) throw new LedgerError('Pick a wallet. Open Edit.');
    if (!categoryId) throw new LedgerError('Pick a category');
    input = { ...base, type: item.type, walletId, categoryId, description: (ov.description ?? item.description).slice(0, 200) };
  }
  return record(db, row, item, input);
}

/** The user edited the entry in the form: record exactly what they sent. */
export function confirmEdited(db: Db, id: number, body: TransactionInput) {
  const row = pendingRow(db, id);
  const item = buildItem(db, row);
  return record(db, row, item, { ...body, source: 'notification', externalId: `notif-${row.id}` });
}

export function dismissNotification(db: Db, id: number): void {
  const row = pendingRow(db, id);
  markDone(db, rowsOf(db, row), 'dismissed', null);
}

/** "Both are real": the second notification is a separate payment after all. */
export function keepBoth(db: Db, id: number): void {
  const row = pendingRow(db, id);
  if (row.kind !== 'possible_duplicate') throw new LedgerError('Not flagged as a duplicate');
  db.update(notifications).set({ kind: row.direction === 'in' ? 'new_income' : 'new_payment', pairId: null }).where(eq(notifications.id, id)).run();
}

/** "Keep one": record the earlier notification, drop the repeat. */
export function keepOne(db: Db, id: number) {
  const row = pendingRow(db, id);
  if (row.kind !== 'possible_duplicate' || !row.pairId) throw new LedgerError('Not flagged as a duplicate');
  const older = db.select().from(notifications).where(eq(notifications.id, row.pairId)).get();
  db.update(notifications).set({ kind: row.direction === 'in' ? 'new_income' : 'new_payment', pairId: null }).where(eq(notifications.id, id)).run();
  const txn = older && older.status === 'pending' ? confirmNotification(db, older.id) : null;
  dismissNotification(db, id);
  return txn;
}

export function closeDay(db: Db): { confirmed: number; left: number } {
  let confirmed = 0;
  for (const item of listPending(db)) {
    if (item.kind === 'possible_duplicate' || item.kind === 'unreadable') continue;
    try {
      confirmNotification(db, item.id);
      confirmed++;
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
    }
  }
  return { confirmed, left: pendingCount(db) };
}

// ---- sources and rules views

export function sourcesView(db: Db) {
  ensureSources(db);
  const all = db.select().from(notifications).all();
  const apps = db.select().from(captureSources).all().map((s) => {
    const mine = all.filter((n) => n.app === s.app);
    const reviewed = mine.filter((n) => n.status !== 'pending');
    return {
      id: s.id, app: s.app, label: s.label, walletId: s.walletId, hasParser: s.hasParser,
      total: mine.length, reviewed: reviewed.length, confirmed: reviewed.filter((n) => n.status === 'confirmed').length,
      lastAt: mine.map((n) => n.receivedAt).sort().pop() ?? null,
    };
  });
  return { apps, lastNotificationAt: all.map((n) => n.receivedAt).sort().pop() ?? null };
}

export function rulesView(db: Db) {
  const all = db.select().from(rules).all();
  return {
    suggested: all.filter((r) => r.status === 'suggested'),
    active: all.filter((r) => r.status === 'active').sort((a, b) => b.uses - a.uses),
    off: all.filter((r) => r.status === 'off'),
  };
}
