import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { convert, jakartaStamp } from '../scripts/convert-money-tracker.js';
import { parseCsv } from '../src/domain/csv.js';
import { freshDb } from './helpers.js';
import { applyImport, previewImport } from '../src/domain/importer.js';

function fixture(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-')), 'x.ckbak');
  const d = new Database(file);
  d.exec(`create table CATEGORY (_id INTEGER PRIMARY KEY, NAME TEXT, TYPE INTEGER);
    create table TRANSACT (_id INTEGER PRIMARY KEY, id_category INTEGER, desc TEXT, type INTEGER, date INTEGER, amount TEXT);
    insert into CATEGORY values (1,'My Food',0),(2,'Hereafter ',0),(3,'Salary ',1);
    insert into TRANSACT values (10,1,'Nasbung ',0,${Date.UTC(2026, 9, 29, 5, 10)},'16000'),
      (11,2,'Sedekah, jumat',0,${Date.UTC(2026, 9, 29, 17, 30)},'50000'),
      (12,1,NULL,0,${Date.UTC(2026, 9, 28, 1, 0)},'abc'),
      (13,3,'Gaji',1,${Date.UTC(2026, 9, 25, 2, 0)},'8000000');`);
  d.close();
  return file;
}

describe('Money Tracker converter', () => {
  it('converts to Jakarta time, trims names, skips bad amounts, maps income', () => {
    const { csv, rows, skipped } = convert(fixture());
    expect(rows).toBe(3);
    expect(skipped).toEqual(['#12: bad amount "abc"']);
    const t = parseCsv(csv);
    expect(t[1]).toEqual(['2026-10-25 09:00', 'income', '8000000', '', '', 'Salary', 'Gaji', '', 'mt-13']);
    expect(t[2]).toEqual(['2026-10-29 12:10', 'expense', '16000', '', '', 'My Food', 'Nasbung', '', 'mt-10']);
    expect(t[3]![6]).toBe('Sedekah, jumat'); // comma survives CSV quoting
    expect(t[3]![5]).toBe('Hereafter');
  });
  it('the output imports cleanly into Moaney and lands in Before Moaney', () => {
    const { csv } = convert(fixture());
    const t = freshDb();
    const p = previewImport(t.db, csv);
    expect(p).toMatchObject({ ready: 3, problems: [], newWallets: [], newCategories: [] });
    expect(applyImport(t.db, p.id, true).imported).toBe(3);
  });
  it('jakartaStamp is UTC+7', () => {
    expect(jakartaStamp(Date.UTC(2026, 0, 1, 20, 0))).toBe('2026-01-02 03:00');
  });
});
