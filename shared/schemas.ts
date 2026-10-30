import { z } from 'zod';

export const WALLET_KINDS = ['bank', 'ewallet', 'cash', 'credit_card', 'investment_cash', 'liability', 'receivable', 'history'] as const;
export const TXN_TYPES = ['expense', 'income', 'transfer'] as const;

export type WalletKind = (typeof WALLET_KINDS)[number];
export type TxnType = (typeof TXN_TYPES)[number];

const occurredAt = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?(\+07:00)?$/, 'Use YYYY-MM-DD or YYYY-MM-DDTHH:mm');

export const transactionInput = z.object({
  type: z.enum(TXN_TYPES),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  walletId: z.number().int().positive(),
  toWalletId: z.number().int().positive().nullish(),
  categoryId: z.number().int().positive().nullish(),
  description: z.string().trim().max(200).default(''),
  note: z.string().trim().max(1000).nullish(),
  occurredAt: occurredAt.optional(),
  source: z.enum(['manual', 'typed', 'import:csv', 'notification']).default('manual'),
  externalId: z.string().trim().max(100).nullish(),
});
export type TransactionInput = z.infer<typeof transactionInput>;

export const transactionPatch = transactionInput.partial().omit({ source: true, externalId: true });
export type TransactionPatch = z.infer<typeof transactionPatch>;

export const walletInput = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(WALLET_KINDS),
  emoji: z.string().max(8).default('👛'),
  openingBalance: z.number().int().default(0),
  openingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});
export const walletPatch = walletInput.partial().extend({ archived: z.boolean().optional() });

export const categoryInput = z.object({
  name: z.string().trim().min(1).max(60),
  emoji: z.string().max(8).default('📦'),
  kind: z.enum(['expense', 'income']).default('expense'),
  monthlyBudget: z.number().int().nonnegative().nullish(),
});
export const categoryPatch = categoryInput.partial().extend({ archived: z.boolean().optional() });

export const loginInput = z.object({ password: z.string().min(1).max(200) });
