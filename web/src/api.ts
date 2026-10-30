import type { TxnType } from '../../shared/schemas';

export interface Wallet {
  id: number;
  name: string;
  kind: string;
  emoji: string;
  balance: number;
  archived: boolean;
  countsTowardTotal: boolean;
}
export interface Category {
  id: number;
  name: string;
  emoji: string;
  kind: 'expense' | 'income';
  archived: boolean;
}
export interface Txn {
  id: number;
  type: TxnType;
  amount: number;
  walletId: number;
  toWalletId: number | null;
  categoryId: number | null;
  description: string;
  note: string | null;
  occurredAt: string;
  localDate: string;
  source: string;
  status: string;
}
export interface AuditRow {
  id: number;
  action: string;
  at: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
}
export interface Proposal {
  raw: string;
  type: TxnType;
  amount: number | null;
  description: string;
  walletId: number | null;
  toWalletId: number | null;
  categoryId: number | null;
  problems: string[];
}
export interface Chip {
  description: string;
  categoryId: number;
  walletId: number;
  amount: number;
  count: number;
}
export interface Summary {
  date: string;
  today: { total: number; count: number };
  month: { total: number; count: number; income: number };
  sameDayLastMonth: { date: string; total: number; count: number };
  topCategories: { categoryId: number; name: string; emoji: string; total: number }[];
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
  newCategories: { name: string; kind: string }[];
  problems: { line: number; reason: string }[];
}

let csrf = '';
export const setCsrf = (t: string) => {
  csrf = t;
};

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${url}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  }
  return (res.headers.get('content-type')?.includes('json') ? res.json() : res.text()) as Promise<T>;
}

export const api = {
  login: (password: string) => call<{ csrf: string }>('POST', '/auth/login', { password }),
  logout: () => call('POST', '/auth/logout'),
  me: () => call<{ csrf: string }>('GET', '/auth/me'),
  wallets: () => call<Wallet[]>('GET', '/wallets'),
  createWallet: (body: unknown) => call<Wallet>('POST', '/wallets', body),
  categories: () => call<Category[]>('GET', '/categories'),
  transactions: (query: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
    return call<Txn[]>('GET', `/transactions?${qs}`);
  },
  transaction: (id: number) => call<Txn & { history: AuditRow[] }>('GET', `/transactions/${id}`),
  createBulk: (items: unknown[]) => call<Txn[]>('POST', '/transactions/bulk', { items }),
  update: (id: number, patch: unknown) => call<Txn>('PATCH', `/transactions/${id}`, patch),
  void: (id: number) => call<Txn>('DELETE', `/transactions/${id}`),
  parse: (text: string) => call<Proposal[]>('POST', '/entries/parse', { text }),
  suggestions: () => call<{ logAgain: Chip[] }>('GET', '/suggestions'),
  summary: (date?: string) => call<Summary>('GET', `/reports/summary${date ? `?date=${date}` : ''}`),
  importPreview: (csv: string) => call<ImportPreview>('POST', '/imports', { csv }),
  importApply: (id: string, createNew: boolean) =>
    call<{ imported: number; skipped: number; createdWallets: string[]; createdCategories: string[] }>('POST', `/imports/${id}/apply`, { createNew }),
  template: () => call<string>('GET', '/imports/template'),
  exportCsv: () => call<string>('GET', '/export.csv'),
};
