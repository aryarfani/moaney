import { parseHumanAmount } from '../../shared/money.js';

export interface Named {
  id: number;
  name: string;
}

export interface Proposal {
  raw: string;
  type: 'expense' | 'income' | 'transfer';
  amount: number | null;
  description: string;
  walletId: number | null;
  toWalletId: number | null;
  categoryId: number | null;
  problems: string[];
}

export interface ParseContext {
  wallets: Named[];
  incomeCategories: Named[];
  /** Normalised description -> categoryId, learned from history. */
  categoryByDescription: Map<string, number>;
  defaultWalletId: number | null;
  defaultExpenseCategoryId: number | null;
}

export const normaliseDescription = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

// Items are separated by "dan"/"and", semicolons, newlines, or a comma followed by a space ("2,5jt" stays intact).
const SPLIT = /\s+(?:dan|and)\s+|\s*;\s*|\s*\n\s*|,\s+/i;
const AMOUNT = /(?:^|\s)((?:rp\.?\s*)?\d[\d.,]*\s*(?:k|rb|ribu|jt|juta)?)(?=\s|$)/gi;
const WALLET_MARK = /\b(?:pakai|pake|using|via|dari|from|with)\s+(.+)$/i;
const INCOME_WORDS = /^(?:gaji|salary|income|terima|received)\b\s*/i;
const TRANSFER = /^(?:transfer|tf)\s+(.+?)\s+(?:to|ke)\s+(.+?)\s+(.+)$/i;

function findWallet(text: string, wallets: Named[]): Named | undefined {
  const t = text.toLowerCase().trim();
  return wallets.find((w) => w.name.toLowerCase() === t) ?? wallets.find((w) => t.includes(w.name.toLowerCase()));
}

// "@2" = log it as 2 separate entries; "x2" = multiply the amount (16k x2 = 32k, one entry).
const COUNT = /(?:^|\s)@(\d{1,3})(?=\s|$)/;
const MULT = /(?:^|\s)[x×](\d{1,3})(?=\s|$)/i;
export const MAX_COPIES = 20;

export function parseEntries(text: string, ctx: ParseContext): Proposal[] {
  return text
    .split(SPLIT)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((raw) => {
      const count = Number(COUNT.exec(raw)?.[1] ?? 1);
      const mult = Number(MULT.exec(raw)?.[1] ?? 1);
      const cleaned = raw.replace(COUNT, ' ').replace(MULT, ' ').replace(/\s+/g, ' ').trim();
      const one = parseOne(cleaned, ctx);
      one.raw = raw;
      if (mult > 1 && one.amount !== null) {
        const total = one.amount * mult;
        if (Number.isSafeInteger(total)) one.amount = total;
        else one.problems.push('Amount too large');
      }
      if (count > MAX_COPIES) {
        one.problems.push(`@${count} is more than ${MAX_COPIES} copies`);
        return [one];
      }
      if (count === 0) {
        one.problems.push('@0 logs nothing');
        return [one];
      }
      return Array.from({ length: count }, () => ({ ...one, problems: [...one.problems] }));
    });
}

function parseOne(raw: string, ctx: ParseContext): Proposal {
  const problems: string[] = [];
  const base: Proposal = {
    raw, type: 'expense', amount: null, description: '', walletId: null, toWalletId: null, categoryId: null, problems,
  };

  const tf = TRANSFER.exec(raw);
  if (tf) {
    const from = findWallet(tf[1]!, ctx.wallets);
    const to = findWallet(tf[2]!, ctx.wallets);
    const amount = parseHumanAmount(tf[3]!);
    if (!from) problems.push(`Unknown wallet "${tf[1]}"`);
    if (!to) problems.push(`Unknown wallet "${tf[2]}"`);
    if (amount === null) problems.push('No amount found');
    return { ...base, type: 'transfer', amount, walletId: from?.id ?? null, toWalletId: to?.id ?? null, description: 'Transfer', problems };
  }

  let rest = raw;
  let type: Proposal['type'] = 'expense';
  if (INCOME_WORDS.test(rest)) {
    type = 'income';
  }

  let wallet: Named | undefined;
  const wm = WALLET_MARK.exec(rest);
  if (wm) {
    wallet = findWallet(wm[1]!, ctx.wallets);
    if (wallet) rest = rest.slice(0, wm.index).trim();
    else problems.push(`Unknown wallet "${wm[1]!.trim()}"`);
  } else {
    // A trailing wallet name without a keyword: "kopi 28k gopay".
    const words = rest.split(/\s+/);
    const last = words[words.length - 1]!;
    const w = words.length > 1 ? findWallet(last, ctx.wallets) : undefined;
    if (w && w.name.toLowerCase() === last.toLowerCase()) {
      wallet = w;
      rest = words.slice(0, -1).join(' ');
    }
  }

  // Use the last amount-like token so "Nasi 2 porsi 36k" picks 36k.
  const matches = [...rest.matchAll(AMOUNT)];
  const hit = matches[matches.length - 1];
  let amount: number | null = null;
  if (hit) {
    amount = parseHumanAmount(hit[1]!);
    rest = (rest.slice(0, hit.index) + ' ' + rest.slice((hit.index ?? 0) + hit[0].length)).trim();
  }
  if (amount === null) problems.push(hit ? `Cannot read amount "${hit[1]!.trim()}"` : 'No amount found');

  let description = rest.replace(INCOME_WORDS, '').replace(/\s+/g, ' ').trim();
  if (type === 'income' && !description) description = 'Income';
  if (!description) problems.push('No description');

  let categoryId: number | null = null;
  if (type === 'income') {
    categoryId = ctx.incomeCategories.find((c) => /salary|gaji/i.test(c.name) && /gaji|salary/i.test(raw))?.id ?? ctx.incomeCategories[0]?.id ?? null;
  } else {
    categoryId = ctx.categoryByDescription.get(normaliseDescription(description)) ?? ctx.defaultExpenseCategoryId;
  }

  return { ...base, type, amount, description, walletId: wallet?.id ?? ctx.defaultWalletId, categoryId, problems };
}
