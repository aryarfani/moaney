import { and, eq, gte, lte } from 'drizzle-orm';
import { formatMoney } from '../../shared/money.js';
import type { Db } from '../db/client.js';
import { categories, notifications, transactions } from '../db/schema.js';
import { normaliseDescription } from './parse-entry.js';
import { periodRange, stepPeriod, type Range } from './reports.js';
import { addDays, today as jakartaToday } from './time.js';

export interface Answer {
  answer: string;
  facts: { label: string; value: string }[];
  note: string;
  followUps: string[];
}

const money = (n: number) => formatMoney(n, 'en');
const MONTH_WORDS: [RegExp, number][] = [
  [/\b(jan(uary|uari)?)\b/, 1], [/\b(feb(ruary|ruari)?)\b/, 2], [/\b(mar(ch|et)?)\b/, 3], [/\b(apr(il)?)\b/, 4],
  [/\b(may|mei)\b/, 5], [/\b(jun(e|i)?)\b/, 6], [/\b(jul(y|i)?)\b/, 7], [/\b(aug(ust)?|agu(stus)?)\b/, 8],
  [/\b(sep(t(ember)?)?)\b/, 9], [/\b(oct(ober)?|okt(ober)?)\b/, 10], [/\b(nov(ember)?|nop(ember)?)\b/, 11], [/\b(dec(ember)?|des(ember)?)\b/, 12],
];
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface Span extends Range {
  label: string;
  kind: 'day' | 'month' | 'year';
  anchor: string;
}

/** Works out the period a question is about; defaults to the current month. */
export function detectPeriod(q: string, todayDate: string): Span {
  const [ty, tm] = todayDate.split('-').map(Number) as [number, number];
  const monthSpan = (y: number, m: number): Span => {
    const anchor = `${y}-${String(m).padStart(2, '0')}-01`;
    return { ...periodRange('monthly', anchor), label: `${FULL_MONTHS[m - 1]} ${y}`, kind: 'month', anchor };
  };
  if (/\b(today|hari ini)\b/.test(q)) return { from: todayDate, to: todayDate, label: 'today', kind: 'day', anchor: todayDate };
  if (/\b(yesterday|kemarin)\b/.test(q)) {
    const d = addDays(todayDate, -1);
    return { from: d, to: d, label: 'yesterday', kind: 'day', anchor: d };
  }
  if (/\b(last year|tahun lalu|tahun kemarin)\b/.test(q)) return { from: `${ty - 1}-01-01`, to: `${ty - 1}-12-31`, label: String(ty - 1), kind: 'year', anchor: `${ty - 1}-01-01` };
  if (/\b(this year|tahun ini)\b/.test(q)) return { from: `${ty}-01-01`, to: `${ty}-12-31`, label: String(ty), kind: 'year', anchor: `${ty}-01-01` };
  if (/\b(last month|bulan lalu|bulan kemarin)\b/.test(q)) {
    const [y, m] = stepPeriod('monthly', `${ty}-${String(tm).padStart(2, '0')}-01`, -1).split('-').map(Number) as [number, number];
    return monthSpan(y, m);
  }
  for (const [re, m] of MONTH_WORDS) {
    if (re.test(q)) {
      const yearMatch = /\b(20\d{2})\b/.exec(q);
      const y = yearMatch ? Number(yearMatch[1]) : m > tm ? ty - 1 : ty;
      return monthSpan(y, m);
    }
  }
  return monthSpan(ty, tm);
}

function previousSpan(s: Span): Span {
  if (s.kind === 'day') {
    const d = addDays(s.anchor, -1);
    return { from: d, to: d, label: 'the day before', kind: 'day', anchor: d };
  }
  if (s.kind === 'year') {
    const y = Number(s.anchor.slice(0, 4)) - 1;
    return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y), kind: 'year', anchor: `${y}-01-01` };
  }
  const [y, m] = stepPeriod('monthly', s.anchor, -1).split('-').map(Number) as [number, number];
  const anchor = `${y}-${String(m).padStart(2, '0')}-01`;
  return { ...periodRange('monthly', anchor), label: `${FULL_MONTHS[m - 1]} ${y}`, kind: 'month', anchor };
}

type Txn = { type: string; amount: number; description: string; categoryId: number | null; localDate: string };

function load(db: Db, r: Range): Txn[] {
  return db
    .select({ type: transactions.type, amount: transactions.amount, description: transactions.description, categoryId: transactions.categoryId, localDate: transactions.localDate })
    .from(transactions)
    .where(and(eq(transactions.status, 'posted'), gte(transactions.localDate, r.from), lte(transactions.localDate, r.to)))
    .all();
}

const sumOf = (rows: Txn[], type: string) => rows.filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const SUPPORTED = [
  'How much did I spend this month?',
  'How much did I spend on food in October?',
  'Top 5 merchants last month',
  'Compare spending with last month',
  'How much income did I get this year?',
];

export function answerQuestion(db: Db, question: string, todayDate = jakartaToday()): Answer {
  const q = question.toLowerCase().replace(/[?!.]+$/g, '').trim();
  // "compare with last month" means: this month against last month.
  const vsLast = /\b(compare|compared|bandingkan|dibanding|banding|versus|vs)\b.*\b(last month|bulan lalu)\b/.test(q);
  const span = detectPeriod(vsLast ? q.replace(/\b(last month|bulan lalu)\b/g, 'this month') : q, todayDate);

  const expenseCats = db.select().from(categories).all().filter((c) => c.kind === 'expense' && c.name.trim());
  // A full category name wins ("my food"); otherwise any whole word of a name ("food") picks every category with it.
  const named = expenseCats.filter((c) => q.includes(c.name.toLowerCase().trim())).sort((a, b) => b.name.length - a.name.length).slice(0, 1);
  const byWord = named.length ? [] : expenseCats.filter((c) => c.name.toLowerCase().split(/\s+/).some((w) => w.length >= 4 && new RegExp(`\\b${w}\\b`).test(q)));
  const matched = named.length ? named : byWord;
  const category = matched.length === 1 ? matched[0] : undefined;
  const catIds = new Set(matched.map((c) => c.id));
  const catLabel = matched.length === 0 ? '' : matched.length === 1 ? matched[0]!.name : matched.map((c) => c.name).join(' + ');

  const wantsTop = /\b(top|terbesar|paling (banyak|sering)|merchants?|toko|where did)\b/.test(q);
  const wantsCompare = /\b(compare|compared|bandingkan|dibanding|banding|versus|vs)\b/.test(q);
  const wantsIncome = /\b(income|pemasukan|salary|gaji|earn(ed)?|received|pendapatan|masuk)\b/.test(q);
  const wantsSpent = /\b(spent|spend|spending|pengeluaran|keluar|berapa|how much|total|expenses?|habis|belanja)\b/.test(q);

  if (!wantsTop && !wantsCompare && !wantsIncome && !wantsSpent && matched.length === 0) {
    return {
      answer: "I could not tell what you are asking. I answer a few kinds of questions about your own records and I do not guess.",
      facts: [],
      note: 'Try one of these.',
      followUps: SUPPORTED.slice(0, 3),
    };
  }

  const rows = load(db, span);
  const transfers = rows.filter((t) => t.type === 'transfer').length;
  const pending = db.select().from(notifications).where(eq(notifications.status, 'pending')).all().length;
  const periodFact = { label: 'Period', value: span.kind === 'day' ? span.from : `${span.from} to ${span.to}` };
  const counted = { label: 'Counted', value: 'Confirmed entries only' };
  const left = { label: 'Left out', value: plural(transfers, 'transfer') };
  const pendingNote = pending > 0 ? `${plural(pending, 'item')} still in review and not included. ` : '';
  const calc = 'Calculated by Moaney from your records, not estimated.';
  const onCat = matched.length ? ` on ${catLabel}` : '';

  if (wantsTop) {
    const n = Math.min(20, Math.max(1, Number(/\btop\s*(\d{1,2})\b/.exec(q)?.[1] ?? 5)));
    const exp = rows.filter((t) => t.type === 'expense' && (matched.length === 0 || (t.categoryId !== null && catIds.has(t.categoryId))) && t.description.trim());
    const groups = new Map<string, { name: string; total: number; count: number }>();
    for (const t of exp) {
      const key = normaliseDescription(t.description);
      const g = groups.get(key) ?? { name: t.description.trim(), total: 0, count: 0 };
      g.total += t.amount;
      g.count += 1;
      groups.set(key, g);
    }
    const top = [...groups.values()].sort((a, b) => b.total - a.total).slice(0, n);
    if (top.length === 0) {
      return { answer: `There are no spending entries${onCat} in ${span.label}.`, facts: [periodFact, counted, left], note: pendingNote + calc, followUps: SUPPORTED.slice(0, 2) };
    }
    return {
      answer: `Your top ${plural(top.length, 'place')}${onCat} in ${span.label}, by total spent:`,
      facts: [...top.map((g) => ({ label: g.name, value: `${money(g.total)} · ${plural(g.count, 'entry', 'entries')}` })), periodFact],
      note: pendingNote + calc,
      followUps: ['How much did I spend this month?', 'Compare spending with last month'],
    };
  }

  if (wantsCompare) {
    const prev = previousSpan(span);
    const now = rows.filter((t) => t.type === 'expense' && (matched.length === 0 || (t.categoryId !== null && catIds.has(t.categoryId)))).reduce((s, t) => s + t.amount, 0);
    const before = load(db, prev).filter((t) => t.type === 'expense' && (matched.length === 0 || (t.categoryId !== null && catIds.has(t.categoryId)))).reduce((s, t) => s + t.amount, 0);
    const diff = now - before;
    const sentence = before === 0 && now === 0
      ? `Nothing was spent${onCat} in either ${span.label} or ${prev.label}.`
      : diff === 0
        ? `You spent the same${onCat} in ${span.label} as in ${prev.label}.`
        : `You spent ${money(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'}${onCat} in ${span.label} than in ${prev.label}.`;
    const whole = span.kind === 'month' && span.to >= todayDate && span.from <= todayDate;
    return {
      answer: sentence,
      facts: [{ label: span.label, value: money(now) }, { label: prev.label, value: money(before) }, left],
      note: pendingNote + (whole ? `${span.label} is not over yet, so this compares a partial month with a full one. ` : '') + calc,
      followUps: ['Top 5 merchants this month', 'How much did I spend this month?'],
    };
  }

  if (wantsIncome && !/\b(spent|spend|spending|pengeluaran|keluar|expenses?|habis|belanja)\b/.test(q)) {
    const inc = sumOf(rows, 'income');
    return {
      answer: inc === 0 ? `No income is recorded in ${span.label}.` : `You received ${money(inc)} in ${span.label}.`,
      facts: [periodFact, counted, left],
      note: pendingNote + calc,
      followUps: ['How much did I spend this month?', 'Compare spending with last month'],
    };
  }

  const exp = rows.filter((t) => t.type === 'expense' && (matched.length === 0 || (t.categoryId !== null && catIds.has(t.categoryId))));
  const total = exp.reduce((s, t) => s + t.amount, 0);
  const facts = [periodFact, { label: 'Entries', value: String(exp.length) }, counted, left];
  let answer = exp.length === 0 ? `No spending${onCat} is recorded in ${span.label}.` : `You spent ${money(total)}${onCat} in ${span.label}.`;
  if (category?.monthlyBudget && span.kind === 'month' && category.monthlyBudget > 0 && exp.length > 0) {
    const pct = Math.round((total / category.monthlyBudget) * 100);
    answer += ` That is ${pct}% of your ${money(category.monthlyBudget)} budget.`;
  }
  return {
    answer,
    facts,
    note: pendingNote + calc,
    followUps: ['Compare spending with last month', 'Top 5 merchants this month'],
  };
}
