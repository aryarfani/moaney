import { and, desc, eq, gte, like, lte, or, type SQL } from 'drizzle-orm';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { categoryInput, categoryPatch, transactionInput, transactionPatch, walletInput, walletPatch } from '../../shared/schemas.js';
import type { Db } from '../db/client.js';
import { auditEvents, categories, transactions, wallets } from '../db/schema.js';
import { applyImport, exportCsv, previewImport, templateCsv } from '../domain/importer.js';
import { categoryByDescription, homeSummary, logAgainChips } from '../domain/insights.js';
import { createTransaction, LedgerError, updateTransaction, voidTransaction, walletBalances } from '../domain/ledger.js';
import { parseEntries } from '../domain/parse-entry.js';
import { today } from '../domain/time.js';
import { captureRouter } from './capture.js';
import { investmentsRouter } from './investments.js';
import { planRouter } from './plan.js';
import { reportsRouter } from './reports.js';

const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new LedgerError('Bad id');
  return n;
};

const listQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  wallet: z.coerce.number().int().optional(),
  category: z.coerce.number().int().optional(),
  type: z.enum(['expense', 'income', 'transfer']).optional(),
  status: z.enum(['posted', 'void']).default('posted'),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export function apiRouter(db: Db): Router {
  const r = Router();

  // ---- wallets
  r.get('/wallets', (_req, res) => {
    const balances = walletBalances(db);
    const list = db.select().from(wallets).orderBy(wallets.sort, wallets.id).all();
    res.json(list.map((w) => ({ ...w, balance: balances.get(w.id) ?? 0, countsTowardTotal: w.kind !== 'history' })));
  });
  r.post('/wallets', (req, res) => {
    const body = walletInput.parse(req.body);
    const row = db.insert(wallets).values(body).returning().get();
    db.insert(auditEvents).values({ actor: 'owner', action: 'create', entity: 'wallet', entityId: row.id, newValue: JSON.stringify(row) }).run();
    res.status(201).json(row);
  });
  r.patch('/wallets/:id', (req, res) => {
    const wid = id(req);
    const body = walletPatch.parse(req.body);
    const old = db.select().from(wallets).where(eq(wallets.id, wid)).get();
    if (!old) throw new LedgerError('Wallet not found', 404);
    const row = db.update(wallets).set(body).where(eq(wallets.id, wid)).returning().get();
    db.insert(auditEvents).values({ actor: 'owner', action: 'update', entity: 'wallet', entityId: wid, oldValue: JSON.stringify(old), newValue: JSON.stringify(row) }).run();
    res.json(row);
  });

  // ---- categories
  r.get('/categories', (_req, res) => {
    res.json(db.select().from(categories).orderBy(categories.sort, categories.id).all());
  });
  r.post('/categories', (req, res) => {
    const row = db.insert(categories).values(categoryInput.parse(req.body)).returning().get();
    db.insert(auditEvents).values({ actor: 'owner', action: 'create', entity: 'category', entityId: row.id, newValue: JSON.stringify(row) }).run();
    res.status(201).json(row);
  });
  r.patch('/categories/:id', (req, res) => {
    const cid = id(req);
    const old = db.select().from(categories).where(eq(categories.id, cid)).get();
    if (!old) throw new LedgerError('Category not found', 404);
    const row = db.update(categories).set(categoryPatch.parse(req.body)).where(eq(categories.id, cid)).returning().get();
    db.insert(auditEvents).values({ actor: 'owner', action: 'update', entity: 'category', entityId: cid, oldValue: JSON.stringify(old), newValue: JSON.stringify(row) }).run();
    res.json(row);
  });

  // ---- transactions
  r.get('/transactions', (req, res) => {
    const q = listQuery.parse(req.query);
    const where: SQL[] = [eq(transactions.status, q.status)];
    if (q.from) where.push(gte(transactions.localDate, q.from));
    if (q.to) where.push(lte(transactions.localDate, q.to));
    if (q.wallet) where.push(or(eq(transactions.walletId, q.wallet), eq(transactions.toWalletId, q.wallet))!);
    if (q.category) where.push(eq(transactions.categoryId, q.category));
    if (q.type) where.push(eq(transactions.type, q.type));
    if (q.q) where.push(like(transactions.description, `%${q.q.replace(/[%_]/g, '')}%`));
    const rows = db.select().from(transactions).where(and(...where))
      .orderBy(desc(transactions.occurredAt), desc(transactions.id)).limit(q.limit).offset(q.offset).all();
    res.json(rows);
  });
  r.get('/transactions/:id', (req, res) => {
    const tid = id(req);
    const row = db.select().from(transactions).where(eq(transactions.id, tid)).get();
    if (!row) throw new LedgerError('Transaction not found', 404);
    const history = db.select().from(auditEvents).where(and(eq(auditEvents.entity, 'transaction'), eq(auditEvents.entityId, tid))).orderBy(desc(auditEvents.id)).all();
    res.json({ ...row, history });
  });
  r.post('/transactions', (req, res) => {
    res.status(201).json(createTransaction(db, transactionInput.parse(req.body)));
  });
  r.post('/transactions/bulk', (req, res) => {
    const items = z.object({ items: z.array(transactionInput).min(1).max(50) }).parse(req.body).items;
    const rows = db.transaction((tx) => items.map((i) => createTransaction(tx as unknown as Db, i)));
    res.status(201).json(rows);
  });
  r.patch('/transactions/:id', (req, res) => {
    res.json(updateTransaction(db, id(req), transactionPatch.parse(req.body)));
  });
  r.delete('/transactions/:id', (req, res) => {
    res.json(voidTransaction(db, id(req), 'owner', typeof req.query.reason === 'string' ? req.query.reason : undefined));
  });

  // ---- typed entry, chips, home
  r.post('/entries/parse', (req, res) => {
    const { text } = z.object({ text: z.string().min(1).max(2000) }).parse(req.body);
    const ws = db.select().from(wallets).where(eq(wallets.archived, false)).all().filter((w) => w.kind !== 'history');
    const cats = db.select().from(categories).all();
    const preferred = ws.find((w) => w.kind === 'cash') ?? ws[0];
    res.json(parseEntries(text, {
      wallets: ws,
      incomeCategories: cats.filter((c) => c.kind === 'income'),
      categoryByDescription: categoryByDescription(db),
      defaultWalletId: preferred?.id ?? null,
      defaultExpenseCategoryId: cats.find((c) => c.name === 'Others')?.id ?? null,
    }));
  });
  r.get('/suggestions', (_req, res) => {
    const cash = db.select().from(wallets).where(eq(wallets.kind, 'cash')).get();
    res.json({ logAgain: logAgainChips(db, 8, 365, today()).map((c) => ({ ...c, walletId: c.walletId || cash?.id || 0 })) });
  });
  r.get('/reports/summary', (req, res) => {
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(today()).parse(req.query.date);
    res.json(homeSummary(db, date));
  });

  // ---- import / export
  r.get('/imports/template', (_req, res) => {
    res.type('text/csv').attachment('moaney-transactions-template.csv').send(templateCsv());
  });
  r.post('/imports', (req, res) => {
    const { csv } = z.object({ csv: z.string().min(1).max(20_000_000) }).parse(req.body);
    res.json(previewImport(db, csv));
  });
  r.post('/imports/:importId/apply', (req, res) => {
    const { createNew } = z.object({ createNew: z.boolean().default(true) }).parse(req.body ?? {});
    try {
      res.json(applyImport(db, String(req.params.importId), createNew));
    } catch (e) {
      if (e instanceof LedgerError) throw e;
      throw new LedgerError((e as Error).message, 410);
    }
  });
  r.get('/export.csv', (_req, res) => {
    res.type('text/csv').attachment('moaney-transactions.csv').send(exportCsv(db));
  });

  r.use(reportsRouter(db));
  r.use(planRouter(db));
  r.use(captureRouter(db));
  r.use(investmentsRouter(db));

  return r;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid input', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  } else if (err instanceof LedgerError) {
    res.status(err.status).json({ error: err.message });
  } else if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'File too large' });
  } else if (err instanceof Error && /UNIQUE constraint/.test(err.message)) {
    res.status(409).json({ error: 'That name already exists' });
  } else {
    console.error(JSON.stringify({ level: 'error', msg: err instanceof Error ? err.message : 'unknown' }));
    res.status(500).json({ error: 'Something went wrong' });
  }
}

