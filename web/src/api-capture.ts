import { call, type Txn } from './api';

export interface OtherNotif {
  id: number;
  app: string;
  appLabel: string;
  text: string;
  receivedAt: string;
  status: string;
}
export interface ReviewItem {
  id: number;
  kind: 'paired_transfer' | 'own_transfer' | 'new_payment' | 'new_income' | 'possible_duplicate' | 'unreadable';
  type: 'expense' | 'income' | 'transfer';
  direction: 'in' | 'out' | null;
  amount: number | null;
  app: string;
  appLabel: string;
  text: string;
  receivedAt: string;
  counterpart: string | null;
  description: string;
  walletId: number | null;
  toWalletId: number | null;
  categoryId: number | null;
  suggestedFrom: number;
  billId: number | null;
  billName: string | null;
  other: OtherNotif | null;
}
export interface SourceApp {
  id: number;
  app: string;
  label: string;
  walletId: number | null;
  hasParser: boolean;
  total: number;
  reviewed: number;
  confirmed: number;
  lastAt: string | null;
}
export interface Device {
  id: number;
  name: string;
  lastSeenAt: string | null;
  createdAt: string;
}
export interface SourcesView {
  apps: SourceApp[];
  devices: Device[];
  lastNotificationAt: string | null;
  paused: boolean;
  names: string[];
  ignore: string[];
  retentionDays: number;
}
export interface Rule {
  id: number;
  pattern: string;
  categoryId: number;
  status: string;
  chosen: number;
  uses: number;
}
export interface RulesView {
  suggested: Rule[];
  active: Rule[];
  off: Rule[];
}

export const capture = {
  pending: () => call<{ items: ReviewItem[]; count: number }>('GET', '/capture/pending'),
  pendingCount: () => call<{ count: number }>('GET', '/capture/pending-count'),
  confirm: (id: number, body: { categoryId?: number; walletId?: number; description?: string; amount?: number } = {}) => call<Txn>('POST', `/capture/${id}/confirm`, body),
  editConfirm: (id: number, body: unknown) => call<Txn>('POST', `/capture/${id}/edit-confirm`, body),
  dismiss: (id: number) => call('POST', `/capture/${id}/dismiss`),
  keepBoth: (id: number) => call('POST', `/capture/${id}/keep-both`),
  keepOne: (id: number) => call('POST', `/capture/${id}/keep-one`),
  closeDay: () => call<{ confirmed: number; left: number }>('POST', '/capture/close-day'),
  sources: () => call<SourcesView>('GET', '/capture/sources'),
  pairDevice: (name: string) => call<{ id: number; name: string; token: string }>('POST', '/capture/device', { name }),
  removeDevice: (id: number) => call('DELETE', `/capture/device/${id}`),
  mapWallet: (sourceId: number, walletId: number | null) => call('PATCH', `/capture/sources/${sourceId}`, { walletId }),
  settings: (body: { paused?: boolean; retentionDays?: 7 | 30 | 90; addName?: string; removeName?: string; addIgnore?: string; removeIgnore?: string }) =>
    call<{ paused: boolean; names: string[]; retentionDays: number }>('PUT', '/capture/settings', body),
  rules: () => call<RulesView>('GET', '/rules'),
  approveRule: (id: number) => call('POST', `/rules/${id}/approve`),
  rejectRule: (id: number) => call('POST', `/rules/${id}/reject`),
  setRule: (id: number, status: 'active' | 'off') => call('PATCH', `/rules/${id}`, { status }),
};
