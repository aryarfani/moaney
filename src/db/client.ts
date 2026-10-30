import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { MIGRATIONS_DIR } from '../paths.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;
export interface DbHandle {
  db: Db;
  raw: Database.Database;
}

export function openDb(file: string): DbHandle {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new Database(file);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, raw };
}
