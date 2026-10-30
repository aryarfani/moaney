import { call, type Txn, type Wallet } from './api';

export interface Goal {
  id: number;
  name: string;
  target: number;
  saved: number;
  walletId: number | null;
  dueDate: string | null;
  archived: boolean;
}
export interface Bill {
  id: number;
  name: string;
  amount: number;
  walletId: number;
  categoryId: number;
  nextDue: string;
  active: boolean;
}
export interface CategoryOverview {
  id: number;
  spent: number;
  budget: number | null;
}
export interface SettingsSummary {
  categories: number;
  goals: { count: number; saved: number };
  bills: { count: number; nextInDays: number | null };
  suggestedRules: number;
}
export interface DataStatus {
  backup: { name: string; size: number; at: string } | null;
  retentionDays: number;
}

export const planApi = {
  summary: () => call<SettingsSummary>('GET', '/settings/summary'),
  values: () => call<Record<string, string>>('GET', '/settings/values'),
  setValue: (key: string, value: string) => call('PUT', `/settings/values/${key}`, { value }),
  walletDetail: (id: number) => call<{ wallet: Wallet; recent: Txn[] }>('GET', `/wallets/${id}/detail`),
  patchWallet: (id: number, body: unknown) => call('PATCH', `/wallets/${id}`, body),
  categoryOverview: (month: string) => call<CategoryOverview[]>('GET', `/categories/overview?month=${month}`),
  createCategory: (body: unknown) => call('POST', '/categories', body),
  patchCategory: (id: number, body: unknown) => call('PATCH', `/categories/${id}`, body),
  goals: () => call<Goal[]>('GET', '/goals'),
  createGoal: (body: unknown) => call<Goal>('POST', '/goals', body),
  patchGoal: (id: number, body: unknown) => call<Goal>('PATCH', `/goals/${id}`, body),
  addToGoal: (id: number, amount: number) => call<Goal>('POST', `/goals/${id}/add`, { amount }),
  bills: () => call<Bill[]>('GET', '/bills'),
  createBill: (body: unknown) => call<Bill>('POST', '/bills', body),
  patchBill: (id: number, body: unknown) => call<Bill>('PATCH', `/bills/${id}`, body),
  payBill: (id: number) => call<{ bill: Bill; transaction: Txn }>('POST', `/bills/${id}/pay`),
  dataStatus: () => call<DataStatus>('GET', '/data/status'),
};
