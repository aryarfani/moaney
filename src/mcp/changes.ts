import type { DbHandle } from '../db/client.js';
import type { Principal } from './oauth.js';
import { LedgerError } from '../domain/ledger.js';
import { today } from '../domain/time.js';
import type { Db } from '../db/client.js';
import { executeOperation } from './operations.js';
import { previewInput, type Operation } from './schemas.js';
import { hash, McpStore, secret } from './store.js';

interface Draft {
  draftId: string;
  digest: string;
  results: unknown[];
  operations: Operation[];
  fingerprint: string;
  principal: Principal;
  expiresAt: string;
  warnings: string[];
}
export interface Receipt {
  draftId: string;
  digest: string;
  results: unknown[];
  committedAt: string;
  principal: Principal;
}
class PreviewRollback {
  constructor(readonly results: unknown[]) {}
}
const TABLES = [
  'wallets',
  'categories',
  'transactions',
  'journal_lines',
  'bills',
  'goals',
  'holdings',
  'holding_trades',
  'notifications',
  'rules',
  'settings',
];
function fingerprint(h: DbHandle) {
  return hash(
    JSON.stringify([
      today(),
      ...TABLES.map((table) =>
        h.raw.prepare(`select * from ${table} order by ${table === 'settings' ? 'key' : 'id'}`).all(),
      ),
    ]),
  );
}
function writeScope(p: Principal) {
  if (!p.scopes.includes('moaney:write')) throw new LedgerError('Write scope required', 403);
}
function same(a: Principal, b: Principal) {
  return a.grantId === b.grantId && a.clientId === b.clientId;
}

export function previewChanges(h: DbHandle, p: Principal, input: unknown): Draft {
  writeScope(p);
  const { operations } = previewInput.parse(input),
    store = new McpStore(h.raw);
  store.prune();
  if (
    store.list<Draft>('draft:').filter((x) => same(x.value.principal, p)).length >= 100 ||
    store.list('draft:').length >= 500
  )
    throw new LedgerError('Too many pending drafts', 429);
  const before = fingerprint(h),
    draftId = secret();
  for (let i = 0; i < operations.length; i++) {
    const o = operations[i]!;
    if (o.op === 'transaction.create' && !o.entry.externalId) o.entry.externalId = `mcp-${draftId}-${i}`;
  }
  let results: unknown[] = [];
  try {
    h.db.transaction((tx) => {
      const values = operations.map((o) => executeOperation(tx as unknown as Db, p, o));
      throw new PreviewRollback(values);
    });
  } catch (e) {
    if (!(e instanceof PreviewRollback)) throw e;
    results = e.results;
  }
  const warnings: string[] = [];
  for (const o of operations) {
    if (o.op !== 'transaction.create') continue;
    const matches = h.raw
      .prepare(
        'select id from transactions where status=? and amount=? and local_date=? and wallet_id=? limit 10',
      )
      .all(
        'posted',
        Number((results[operations.indexOf(o)] as { amount: number }).amount),
        o.entry.occurredAt.slice(0, 10),
        o.entry.walletId,
      ) as { id: number }[];
    if (matches.length)
      warnings.push(
        `Possible duplicate for ${o.entry.description}: existing transaction IDs ${matches.map((r) => r.id).join(', ')}. Review before approving.`,
      );
  }
  const draft: Draft = {
    draftId,
    digest: hash(JSON.stringify({ draftId, operations, before, principal: p.grantId })),
    operations,
    results,
    fingerprint: before,
    principal: p,
    expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
    warnings,
  };
  store.put(`draft:${draftId}`, draft, 30 * 60000);
  return draft;
}

export function commitChanges(h: DbHandle, p: Principal, draftId: string, digest: string): Receipt {
  writeScope(p);
  return h.db.transaction((tx) => {
    const store = new McpStore(h.raw),
      receipt = store.get<Receipt>(`receipt:${draftId}`);
    if (receipt) {
      if (!same(receipt.principal, p)) throw new LedgerError('Draft not found', 404);
      if (receipt.digest !== digest) throw new LedgerError('Confirmation digest does not match', 409);
      return receipt;
    }
    const draft = store.get<Draft>(`draft:${draftId}`);
    if (!draft || !same(draft.principal, p)) throw new LedgerError('Draft expired or not found', 404);
    if (draft.digest !== digest) throw new LedgerError('Confirmation digest does not match', 409);
    if (draft.fingerprint !== fingerprint(h))
      throw new LedgerError('Moaney data changed; preview the batch again', 409);
    const results = draft.operations.map((o) => executeOperation(tx as unknown as Db, p, o));
    const value: Receipt = { draftId, digest, results, committedAt: new Date().toISOString(), principal: p };
    store.put(`receipt:${draftId}`, value);
    store.remove(`draft:${draftId}`);
    return value;
  });
}
