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

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const goals = sqliteTable('goals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  target: integer('target').notNull(),
  saved: integer('saved').notNull().default(0),
  walletId: integer('wallet_id').references(() => wallets.id),
  dueDate: text('due_date'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
});

export const bills = sqliteTable('bills', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  amount: integer('amount').notNull(),
  walletId: integer('wallet_id').notNull().references(() => wallets.id),
  categoryId: integer('category_id').notNull().references(() => categories.id),
  nextDue: text('next_due').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
});

export const rules = sqliteTable('rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pattern: text('pattern').notNull().unique(), // lower-case merchant text
  categoryId: integer('category_id').notNull().references(() => categories.id),
  status: text('status').notNull().default('pending'), // pending | suggested | active | off
  chosen: integer('chosen').notNull().default(0),
  uses: integer('uses').notNull().default(0),
});

export const captureSources = sqliteTable('capture_sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  app: text('app').notNull().unique(), // gopay | mybca | jago
  label: text('label').notNull(),
  walletId: integer('wallet_id').references(() => wallets.id),
  hasParser: integer('has_parser', { mode: 'boolean' }).notNull().default(true),
});

export const devices = sqliteTable('devices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  lastSeenAt: text('last_seen_at'),
  createdAt: text('created_at').notNull().default(now),
});

export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    app: text('app').notNull(),
    text: text('text').notNull(),
    receivedAt: text('received_at').notNull(), // Jakarta local ISO
    status: text('status').notNull().default('pending'), // pending | confirmed | dismissed
    kind: text('kind'), // paired_transfer | new_payment | new_income | possible_duplicate | unreadable
    direction: text('direction'), // out | in
    amount: integer('amount'),
    counterpart: text('counterpart'),
    walletId: integer('wallet_id'),
    categoryId: integer('category_id'),
    pairId: integer('pair_id'), // the other notification of a paired transfer / duplicate
    billId: integer('bill_id'),
    transactionId: integer('transaction_id'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('notif_status_idx').on(t.status)],
);

export const holdings = sqliteTable('holdings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  symbol: text('symbol').notNull().unique(),
  name: text('name').notNull().default(''),
  kind: text('kind').notNull(), // sbn | stock | fund | gold | cash | other
  unitLabel: text('unit_label').notNull().default('units'),
  unitsE4: integer('units_e4').notNull().default(0), // units * 10_000
  cost: integer('cost').notNull().default(0), // minor units, cost of what is still held
  price: integer('price'), // minor units per ONE unit
  priceDate: text('price_date'),
  incomeYtd: integer('income_ytd').notNull().default(0),
  note: text('note'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
});

export const holdingTrades = sqliteTable('holding_trades', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  holdingId: integer('holding_id').notNull().references(() => holdings.id),
  kind: text('kind').notNull(), // buy | sell | income
  date: text('date').notNull(),
  unitsE4: integer('units_e4').notNull().default(0),
  amount: integer('amount').notNull(), // minor units, total
});
