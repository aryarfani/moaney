// One-off converter: Money Tracker (Android) .ckbak backup -> Moaney transactions.csv.
// Usage: npm run convert:money-tracker -- <backup.ckbak> <out.csv>
// The backup is a plain SQLite file; it is opened read-only and never modified.
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { toCsv } from '../src/domain/csv.js';
import { TEMPLATE_HEADER } from '../src/domain/importer.js';

interface Row {
  _id: number;
  category: string;
  desc: string | null;
  type: number;
  date: number;
  amount: string;
}

/** Epoch ms -> "YYYY-MM-DD HH:mm" in Asia/Jakarta (fixed +07:00, no DST). */
export function jakartaStamp(ms: number): string {
  return new Date(ms + 7 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}

export function convert(backupPath: string): { csv: string; rows: number; skipped: string[] } {
  const db = new Database(backupPath, { readonly: true, fileMustExist: true });
  const rows = db
    .prepare('select t._id, c.NAME as category, t."desc" as desc, t.type, t.date, t.amount from TRANSACT t join CATEGORY c on c._id = t.id_category order by t.date, t._id')
    .all() as Row[];
  db.close();

  const out: string[][] = [];
  const skipped: string[] = [];
  for (const r of rows) {
    const amount = r.amount.trim();
    if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
      skipped.push(`#${r._id}: bad amount "${r.amount}"`);
      continue;
    }
    // Money Tracker TYPE: 0 = expense, 1 = income. Category names carry stray trailing spaces.
    out.push([
      jakartaStamp(r.date),
      r.type === 1 ? 'income' : 'expense',
      amount,
      '', // no wallets in Money Tracker: lands in "Before Moaney"
      '',
      r.category.trim(),
      (r.desc ?? '').trim(),
      '',
      `mt-${r._id}`,
    ]);
  }
  return { csv: toCsv([TEMPLATE_HEADER, ...out]), rows: out.length, skipped };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('convert-money-tracker.ts')) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('Usage: npm run convert:money-tracker -- <backup.ckbak> <out.csv>');
    process.exit(1);
  }
  const { csv, rows, skipped } = convert(input);
  fs.writeFileSync(output, csv, 'utf8');
  console.log(`Wrote ${rows} rows to ${output}`);
  if (skipped.length) console.log(`Skipped ${skipped.length}:\n${skipped.slice(0, 20).join('\n')}`);
}
