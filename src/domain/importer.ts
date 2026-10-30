import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { decimalToMinor } from '../../shared/money.js';
import type { TransactionInput } from '../../shared/schemas.js';
import type { Db } from '../db/client.js';
import { auditEvents, categories, transactions, wallets } from '../db/schema.js';
import { parseCsv, toCsv } from './csv.js';
import { insertTransaction } from './ledger.js';
import { normaliseDescription } from './parse-entry.js';
import { normaliseOccurredAt } from './time.js';

export const TEMPLATE_HEADER = ['date', 'type', 'amount', 'wallet', 'to_wallet', 'category', 'description', 'note', 'external_id'];
export const HISTORY_WALLET = 'Before Moaney';

export function templateCsv(): string {
  return toCsv([
    TEMPLATE_HEADER,
    ['2026-10-29 12:10', 'expense', '16000', 'Cash', '', 'My Food', 'Nasbung', '', 'example-1'],
    ['2026-10-29', 'transfer', '500000', 'BCA', 'GoPay', '', 'Top up', '', 'example-2'],
    ['2026-10-25', 'income', '8000000', 'BCA', '', 'Salary', 'October salary', '', 'example-3'],
    ['2022-01-05', 'expense', '9000', '', '', 'My Food', 'Old entry with no wallet', '', 'example-4'],
  ]);
}

export interface ImportRow {
  line: number;
  input: Omit<TransactionInput, 'walletId' | 'toWalletId' | 'categoryId'> & {
    wallet: string;
    toWallet: string | null;
    category: string | null;
  };
}

export interface ImportProblem {
  line: number;
  reason: string;
}

export interface ImportPreview {
  id: string;
  total: number;
  ready: number;
  duplicates: number;
  dateFrom: string | null;
  dateTo: string | null;
  categoriesInFile: string[];
  newWallets: string[];
  newCategories: { name: string; kind: 'expense' | 'income' }[];
  problems: ImportProblem[];
}

interface Staged {
  preview: ImportPreview;
  rows: ImportRow[];
  createdAt: number;
}

const staged = new Map<string, Staged>();
const TTL_MS = 30 * 60_000;

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, s] of staged) if (s.createdAt < cutoff) staged.delete(id);
}

const dupKey = (date: string, description: string, amount: number, wallet: string) =>
  `${date.slice(0, 16)}|${normaliseDescription(description)}|${amount}|${wallet.toLowerCase()}`;

export function previewImport(db: Db, csv: string): ImportPreview {
  sweep();
  const table = parseCsv(csv);
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const problems: ImportProblem[] = [];
  const missing = ['date', 'type', 'amount'].filter((h) => !header.includes(h));
  if (missing.length) {
    problems.push({ line: 1, reason: `Missing column: ${missing.join(', ')}` });
    return emptyPreview(problems);
  }
  const col = (r: string[], name: string) => (r[header.indexOf(name)] ?? '').trim();

  const knownWallets = new Map(db.select().from(wallets).all().map((w) => [w.name.toLowerCase(), w]));
  const knownCats = new Map(db.select().from(categories).all().map((c) => [c.name.toLowerCase(), c]));
  const existing = db.select().from(transactions).where(eq(transactions.status, 'posted')).all();
  const walletName = new Map(Array.from(knownWallets.values()).map((w) => [w.id, w.name]));
  const seenExternal = new Set(existing.filter((t) => t.externalId).map((t) => t.externalId!));
  const seenKeys = new Set(existing.map((t) => dupKey(t.occurredAt, t.description, t.amount, walletName.get(t.walletId) ?? '')));

  const rows: ImportRow[] = [];
  const newWallets = new Set<string>();
  const newCats = new Map<string, 'expense' | 'income'>();
  const catsInFile = new Set<string>();
  let duplicates = 0;
  let dateFrom: string | null = null;
  let dateTo: string | null = null;
  const fileExternal = new Set<string>();
  const fileKeys = new Set<string>();

  for (let i = 1; i < table.length; i++) {
    const r = table[i]!;
    const line = i + 1;
    const fail = (reason: string) => problems.push({ line, reason });
    const type = col(r, 'type').toLowerCase();
    if (type !== 'expense' && type !== 'income' && type !== 'transfer') { fail(`Unknown type "${col(r, 'type')}"`); continue; }
    let occurredAt: string;
    try { occurredAt = normaliseOccurredAt(col(r, 'date')); } catch { fail(`Bad date "${col(r, 'date')}"`); continue; }
    const amount = decimalToMinor(col(r, 'amount'));
    if (amount === null || amount <= 0) { fail(`Bad amount "${col(r, 'amount')}"`); continue; }
    const wallet = col(r, 'wallet') || HISTORY_WALLET;
    const toWallet = col(r, 'to_wallet') || null;
    const category = col(r, 'category') || null;
    if (type === 'transfer') {
      if (!toWallet) { fail('Transfer needs to_wallet'); continue; }
      if (toWallet.toLowerCase() === wallet.toLowerCase()) { fail('Transfer needs two different wallets'); continue; }
      if (wallet === HISTORY_WALLET || toWallet.toLowerCase() === HISTORY_WALLET.toLowerCase()) { fail('Transfers need real wallets'); continue; }
    } else {
      if (toWallet) { fail('to_wallet is only for transfers'); continue; }
      if (!category) { fail('Category is required'); continue; }
      const known = knownCats.get(category.toLowerCase());
      if (known && known.kind !== type) { fail(`Category "${category}" is for ${known.kind}`); continue; }
    }
    const externalId = col(r, 'external_id') || null;
    const key = dupKey(occurredAt, col(r, 'description'), amount, wallet);
    if ((externalId && (seenExternal.has(externalId) || fileExternal.has(externalId))) || (!externalId && (seenKeys.has(key) || fileKeys.has(key)))) {
      duplicates++;
      continue;
    }
    if (externalId) fileExternal.add(externalId); else fileKeys.add(key);

    for (const w of [wallet, toWallet]) if (w && !knownWallets.has(w.toLowerCase())) newWallets.add(w);
    if (category) {
      catsInFile.add(category);
      if (!knownCats.has(category.toLowerCase())) newCats.set(category, type as 'expense' | 'income');
    }
    const day = occurredAt.slice(0, 10);
    if (!dateFrom || day < dateFrom) dateFrom = day;
    if (!dateTo || day > dateTo) dateTo = day;
    rows.push({
      line,
      input: {
        type, amount, wallet, toWallet, category, occurredAt, source: 'import:csv', externalId,
        description: col(r, 'description'), note: col(r, 'note') || null,
      },
    });
  }

  const preview: ImportPreview = {
    id: randomUUID(),
    total: table.length - 1,
    ready: rows.length,
    duplicates,
    dateFrom,
    dateTo,
    categoriesInFile: [...catsInFile].sort(),
    newWallets: [...newWallets],
    newCategories: [...newCats].map(([name, kind]) => ({ name, kind })),
    problems: problems.slice(0, 200),
  };
  staged.set(preview.id, { preview, rows, createdAt: Date.now() });
  return preview;
}

function emptyPreview(problems: ImportProblem[]): ImportPreview {
  return { id: '', total: 0, ready: 0, duplicates: 0, dateFrom: null, dateTo: null, categoriesInFile: [], newWallets: [], newCategories: [], problems };
}

export interface ImportResult {
  imported: number;
  skipped: number;
  createdWallets: string[];
  createdCategories: string[];
}

/** createNew=false skips rows that need a wallet or category that does not exist yet. */
export function applyImport(db: Db, id: string, createNew: boolean, actor = 'owner'): ImportResult {
  const s = staged.get(id);
  if (!s) throw new Error('Import expired. Upload the file again.');
  let skipped = 0;
  const createdWallets: string[] = [];
  const createdCategories: string[] = [];

  const imported = db.transaction((tx) => {
    const walletIds = new Map(tx.select().from(wallets).all().map((w) => [w.name.toLowerCase(), w.id]));
    const catIds = new Map(tx.select().from(categories).all().map((c) => [c.name.toLowerCase(), c.id]));

    const walletId = (name: string): number | null => {
      const hit = walletIds.get(name.toLowerCase());
      if (hit) return hit;
      if (!createNew) return null;
      const kind = name === HISTORY_WALLET ? 'history' : 'bank';
      const created = tx.insert(wallets).values({ name, kind, emoji: kind === 'history' ? '🕰️' : '👛' }).returning().get();
      walletIds.set(name.toLowerCase(), created.id);
      createdWallets.push(name);
      return created.id;
    };
    const categoryId = (name: string, kind: 'expense' | 'income'): number | null => {
      const hit = catIds.get(name.toLowerCase());
      if (hit) return hit;
      if (!createNew) return null;
      const created = tx.insert(categories).values({ name, kind }).returning().get();
      catIds.set(name.toLowerCase(), created.id);
      createdCategories.push(name);
      return created.id;
    };

    let n = 0;
    for (const { input } of s.rows) {
      const w = walletId(input.wallet);
      const tw = input.toWallet ? walletId(input.toWallet) : null;
      const c = input.category ? categoryId(input.category, input.type as 'expense' | 'income') : null;
      if (!w || (input.toWallet && !tw) || (input.category && !c)) { skipped++; continue; }
      insertTransaction(tx, {
        type: input.type, amount: input.amount, walletId: w, toWalletId: tw, categoryId: c,
        description: input.description, note: input.note, occurredAt: input.occurredAt,
        source: 'import:csv', externalId: input.externalId,
      }, actor);
      n++;
    }
    tx.insert(auditEvents).values({
      actor, action: 'import', entity: 'import', newValue: JSON.stringify({ imported: n, skipped, createdWallets, createdCategories }),
    }).run();
    return n;
  });
  staged.delete(id);
  return { imported, skipped, createdWallets, createdCategories };
}

export function exportCsv(db: Db): string {
  const w = new Map(db.select().from(wallets).all().map((x) => [x.id, x.name]));
  const c = new Map(db.select().from(categories).all().map((x) => [x.id, x.name]));
  const rows = db.select().from(transactions).where(and(eq(transactions.status, 'posted'))).orderBy(transactions.occurredAt).all();
  const major = (n: number) => `${Math.trunc(n / 100)}${n % 100 ? '.' + String(n % 100).padStart(2, '0') : ''}`;
  return toCsv([
    TEMPLATE_HEADER,
    ...rows.map((t) => [
      t.occurredAt.slice(0, 16).replace('T', ' '), t.type, major(t.amount),
      w.get(t.walletId) === HISTORY_WALLET ? '' : w.get(t.walletId),
      t.toWalletId ? w.get(t.toWalletId) : '', t.categoryId ? c.get(t.categoryId) : '',
      t.description, t.note, t.externalId ?? `moaney-${t.id}`,
    ]),
  ]);
}
