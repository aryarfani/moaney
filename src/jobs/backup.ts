import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { jakartaNow } from '../domain/time.js';

/** Online backup via VACUUM INTO, with rotation. Returns the file written. */
export function runBackup(raw: Database.Database, dir: string, keep: number, stamp = jakartaNow()): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `moaney-${stamp.slice(0, 10)}-${stamp.slice(11, 16).replace(':', '')}.db`);
  if (fs.existsSync(file)) fs.rmSync(file);
  raw.prepare('VACUUM INTO ?').run(file);
  fs.chmodSync(file, 0o600);
  const all = fs.readdirSync(dir).filter((f) => /^moaney-.*\.db$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, old));
  return file;
}

/** Checks hourly; takes one backup per Jakarta day once it is 03:00 or later. */
export function scheduleBackups(raw: Database.Database, dir: string, keep: number): NodeJS.Timeout {
  const tick = () => {
    const now = jakartaNow();
    const prefix = `moaney-${now.slice(0, 10)}`;
    const done = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith(prefix));
    if (!done && Number(now.slice(11, 13)) >= 3) {
      try {
        runBackup(raw, dir, keep);
        console.log(JSON.stringify({ level: 'info', msg: 'backup written' }));
      } catch (e) {
        console.error(JSON.stringify({ level: 'error', msg: `backup failed: ${(e as Error).message}` }));
      }
    }
  };
  tick();
  const t = setInterval(tick, 3600_000);
  t.unref();
  return t;
}
