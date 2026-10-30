import { call } from './api';

export type HoldingKind = 'sbn' | 'stock' | 'fund' | 'gold' | 'cash' | 'other';
export type TradeKind = 'buy' | 'sell' | 'income';

export interface Holding {
  id: number;
  symbol: string;
  name: string;
  kind: HoldingKind;
  unitLabel: string;
  unitsE4: number;
  cost: number;
  price: number | null;
  priceDate: string | null;
  incomeYtd: number;
  note: string | null;
  value: number;
  gain: number | null;
}
export interface Trade {
  id: number;
  kind: TradeKind;
  date: string;
  unitsE4: number;
  amount: number;
}
export interface Portfolio {
  value: number;
  gain: number;
  gainBp: number;
  pricedCost: number;
  priceMissing: number;
  pricesAsOf: string | null;
  incomeYtd: number;
  year: string;
  allocation: { kind: HoldingKind; value: number; percent: number }[];
  holdings: Holding[];
}
export type HoldingDetail = Holding & { trades: Trade[] };

export const invApi = {
  list: () => call<Portfolio>('GET', '/investments'),
  detail: (id: number) => call<HoldingDetail>('GET', `/investments/${id}`),
  create: (body: unknown) => call<HoldingDetail>('POST', '/investments', body),
  trade: (id: number, body: { kind: TradeKind; date: string; units: string; amount: number }) => call<HoldingDetail>('POST', `/investments/${id}/trades`, body),
  price: (id: number, price: number, date: string) => call<HoldingDetail>('PUT', `/investments/${id}/price`, { price, date }),
  archive: (id: number) => call<{ ok: true }>('DELETE', `/investments/${id}`),
};
