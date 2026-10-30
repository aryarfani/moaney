import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))`;

export const sessions = sqliteTable('sessions', {
  idHash: text('id_hash').primaryKey(),
  csrf: text('csrf').notNull(),
  createdAt: text('created_at').notNull().default(now),
  expiresAt: text('expires_at').notNull(),
});

export const wallets = sqliteTable('wallets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  kind: text('kind').notNull(),
  currency: text('currency').notNull().default('IDR'),
  emoji: text('emoji').notNull().default('👛'),
  openingBalance: integer('opening_balance').notNull().default(0),
  openingDate: text('opening_date'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  sort: integer('sort').notNull().default(0),
  createdAt: text('created_at').notNull().default(now),
});

export const categories = sqliteTable('categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  emoji: text('emoji').notNull().default('📦'),
  kind: text('kind').notNull().default('expense'),
  monthlyBudget: integer('monthly_budget'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  sort: integer('sort').notNull().default(0),
});

export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    amount: integer('amount').notNull(),
    walletId: integer('wallet_id').notNull().references(() => wallets.id),
    toWalletId: integer('to_wallet_id').references(() => wallets.id),
    categoryId: integer('category_id').references(() => categories.id),
    description: text('description').notNull().default(''),
    note: text('note'),
    occurredAt: text('occurred_at').notNull(), // YYYY-MM-DDTHH:mm:ss+07:00
    localDate: text('local_date').notNull(), // YYYY-MM-DD in Asia/Jakarta
    source: text('source').notNull().default('manual'),
    status: text('status').notNull().default('posted'), // posted | void
    externalId: text('external_id'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    index('txn_date_idx').on(t.localDate),
    index('txn_wallet_idx').on(t.walletId),
    index('txn_external_idx').on(t.externalId),
  ],
);

export const journalLines = sqliteTable(
  'journal_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    transactionId: integer('transaction_id').notNull().references(() => transactions.id, { onDelete: 'cascade' }),
    accountType: text('account_type').notNull(), // wallet | category
    accountId: integer('account_id').notNull(),
    debit: integer('debit').notNull().default(0),
    credit: integer('credit').notNull().default(0),
  },
  (t) => [index('jl_txn_idx').on(t.transactionId), index('jl_account_idx').on(t.accountType, t.accountId)],
);

export const auditEvents = sqliteTable('audit_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: integer('entity_id'),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  reason: text('reason'),
  at: text('at').notNull().default(now),
});
