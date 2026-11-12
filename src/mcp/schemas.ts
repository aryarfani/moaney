import { z } from 'zod';
import {
  categoryInput,
  categoryPatch,
  transactionInput,
  transactionPatch,
  walletInput,
  walletPatch,
} from '../../shared/schemas.js';
import { decimalToMinor } from '../../shared/money.js';
import { normaliseOccurredAt } from '../domain/time.js';
import { HOLDING_KINDS } from '../domain/investments.js';

export const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    try {
      normaliseOccurredAt(s);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid calendar date');
const validMoney = (s: string, zero: boolean, signed = false) => {
  const n = decimalToMinor(signed ? s.replace(/^-/, '') : s);
  return n !== null && (zero ? n >= 0 : n > 0);
};
export const rupiah = z
  .string()
  .regex(/^\d+(?:\.\d{1,2})?$/)
  .refine((s) => validMoney(s, false), 'Use a positive decimal rupiah amount within the safe integer range')
  .describe(
    'Rupiah decimal string, no thousands separators: "68600" means Rp68,600; "123.45" means Rp123.45.',
  );
const zeroMoney = z
  .string()
  .regex(/^\d+(?:\.\d{1,2})?$/)
  .refine((s) => validMoney(s, true), 'Invalid rupiah amount');
const signedMoney = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,2})?$/)
  .refine((s) => validMoney(s, true, true), 'Invalid rupiah amount');
export const toMinor = (s: string) => (s.startsWith('-') ? -1 : 1) * decimalToMinor(s.replace(/^-/, ''))!;
const occurred = transactionInput.shape.occurredAt.unwrap().refine((s) => {
  try {
    normaliseOccurredAt(s);
    return true;
  } catch {
    return false;
  }
}, 'Invalid date/time');
export const entrySchema = transactionInput
  .omit({ amount: true, source: true })
  .extend({ amountRupiah: rupiah, occurredAt: occurred })
  .strict();
const entryPatch = transactionPatch
  .omit({ amount: true })
  .extend({
    amountRupiah: rupiah.optional(),
    occurredAt: occurred.optional(),
    description: transactionInput.shape.description.removeDefault().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Supply at least one change');
const wallet = walletInput
  .omit({ openingBalance: true })
  .extend({ openingBalanceRupiah: signedMoney.default('0'), openingDate: date.nullish() })
  .strict();
const walletEdit = walletPatch
  .omit({ openingBalance: true })
  .extend({
    openingBalanceRupiah: signedMoney.optional(),
    openingDate: date.nullish(),
    emoji: walletInput.shape.emoji.removeDefault().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Supply at least one change');
const category = categoryInput
  .omit({ monthlyBudget: true })
  .extend({ monthlyBudgetRupiah: zeroMoney.nullish() })
  .strict();
const categoryEdit = categoryPatch
  .omit({ monthlyBudget: true })
  .extend({
    monthlyBudgetRupiah: zeroMoney.nullish(),
    emoji: categoryInput.shape.emoji.removeDefault().optional(),
    kind: categoryInput.shape.kind.removeDefault().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Supply at least one change');
const goal = z
  .object({
    name: z.string().trim().min(1).max(60),
    targetRupiah: rupiah,
    savedRupiah: zeroMoney.default('0'),
    walletId: id.nullish(),
    dueDate: date.nullish(),
  })
  .strict();
const goalEdit = goal
  .partial()
  .extend({ archived: z.boolean().optional(), savedRupiah: zeroMoney.optional() })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Supply at least one change');
const bill = z
  .object({
    name: z.string().trim().min(1).max(60),
    amountRupiah: rupiah,
    walletId: id,
    categoryId: id,
    nextDue: date,
  })
  .strict();
const billEdit = bill.partial().extend({ active: z.boolean().optional() }).strict();
const holding = z
  .object({
    symbol: z.string().trim().min(1).max(30),
    name: z.string().trim().max(80).default(''),
    kind: z.enum(HOLDING_KINDS),
    unitLabel: z.string().trim().min(1).max(12).optional(),
    note: z.string().trim().max(500).nullish(),
    priceRupiah: zeroMoney.nullish(),
    priceDate: date.nullish(),
    first: z
      .object({ date, units: z.string().max(20), amountRupiah: rupiah })
      .strict()
      .nullish(),
  })
  .strict();
const holdingEdit = holding
  .omit({ symbol: true, priceRupiah: true, priceDate: true, first: true })
  .partial()
  .extend({ name: z.string().trim().max(80).optional() })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Supply at least one change');
const trade = z
  .object({
    kind: z.enum(['buy', 'sell', 'income']),
    date,
    units: z.string().max(20).default('0'),
    amountRupiah: rupiah,
  })
  .strict();
const overrides = z
  .object({ categoryId: id, walletId: id, description: z.string().trim().max(200), amountRupiah: rupiah })
  .partial()
  .strict();
const rule = z
  .object({
    pattern: z.string().trim().toLowerCase().min(2).max(200),
    categoryId: id,
    status: z.enum(['pending', 'active', 'off']).default('pending'),
  })
  .strict();
export const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('transaction.create'), entry: entrySchema }).strict(),
  z.object({ op: z.literal('transaction.update'), id, patch: entryPatch }).strict(),
  z.object({ op: z.literal('transaction.void'), id, reason: z.string().trim().min(1).max(500) }).strict(),
  z.object({ op: z.literal('wallet.create'), wallet }).strict(),
  z.object({ op: z.literal('wallet.update'), id, patch: walletEdit }).strict(),
  z.object({ op: z.literal('category.create'), category }).strict(),
  z.object({ op: z.literal('category.update'), id, patch: categoryEdit }).strict(),
  z.object({ op: z.literal('goal.create'), goal }).strict(),
  z.object({ op: z.literal('goal.update'), id, patch: goalEdit }).strict(),
  z.object({ op: z.literal('goal.add'), id, amountRupiah: rupiah }).strict(),
  z.object({ op: z.literal('bill.create'), bill }).strict(),
  z.object({ op: z.literal('bill.update'), id, patch: billEdit }).strict(),
  z.object({ op: z.literal('bill.pay'), id, paidOn: date }).strict(),
  z.object({ op: z.literal('holding.create'), holding }).strict(),
  z.object({ op: z.literal('holding.update'), id, patch: holdingEdit }).strict(),
  z.object({ op: z.literal('holding.archive'), id }).strict(),
  z.object({ op: z.literal('holding.trade'), id, trade }).strict(),
  z.object({ op: z.literal('holding.price'), id, priceRupiah: zeroMoney, date }).strict(),
  z.object({ op: z.literal('capture.confirm'), id, overrides: overrides.default({}) }).strict(),
  z.object({ op: z.literal('capture.edit_confirm'), id, entry: entrySchema }).strict(),
  z.object({ op: z.literal('capture.dismiss'), id }).strict(),
  z.object({ op: z.literal('capture.keep_one'), id }).strict(),
  z.object({ op: z.literal('capture.keep_both'), id }).strict(),
  z.object({ op: z.literal('rule.create'), rule }).strict(),
  z
    .object({
      op: z.literal('rule.update'),
      id,
      patch: rule
        .partial()
        .extend({ status: z.enum(['pending', 'active', 'off']).optional() })
        .refine((p) => Object.keys(p).length > 0, 'Supply at least one change'),
    })
    .strict(),
]);
export type Operation = z.infer<typeof operationSchema>;
export const previewInput = z.object({ operations: z.array(operationSchema).min(1).max(100) }).strict();
