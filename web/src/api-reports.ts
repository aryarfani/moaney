import { call } from './api';

export type Period = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Overview {
  period: Period;
  date: string;
  from: string;
  to: string;
  label: string;
  previousLabel: string;
  prevDate: string;
  nextDate: string;
  out: number;
  in: number;
  previousOut: number;
  count: number;
  avgPerDay: number;
  trend: { key: string; label: string; total: number }[];
  leadingBlanks: number;
  cumulative: { current: number[]; previous: number[] } | null;
  categories: { categoryId: number; name: string; emoji: string; total: number; share: number }[];
}

export interface Answer {
  answer: string;
  facts: { label: string; value: string }[];
  note: string;
  followUps: string[];
}

export const reportsApi = {
  overview: (period: Period, date: string) => call<Overview>('GET', `/reports/overview?period=${period}&date=${date}`),
  ask: (question: string) => call<Answer>('POST', '/ask', { question }),
};
