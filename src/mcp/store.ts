import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

export const secret = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Secrets are hashed by callers; this table never contains raw codes or bearer tokens. */
export class McpStore {
  constructor(readonly raw: Database.Database) {}
  get<T>(key: string): T | undefined {
    const row = this.raw.prepare('select value, expires_at from mcp_records where key = ?').get(key) as
      | { value: string; expires_at: number | null }
      | undefined;
    if (!row || (row.expires_at !== null && row.expires_at <= Date.now())) return;
    return JSON.parse(row.value) as T;
  }
  put(key: string, value: unknown, ttlMs?: number) {
    this.raw
      .prepare(
        'insert into mcp_records(key,value,expires_at) values(?,?,?) on conflict(key) do update set value=excluded.value, expires_at=excluded.expires_at',
      )
      .run(key, JSON.stringify(value), ttlMs === undefined ? null : Date.now() + ttlMs);
  }
  remove(key: string) {
    this.raw.prepare('delete from mcp_records where key = ?').run(key);
  }
  list<T>(prefix: string): { key: string; value: T }[] {
    return (
      this.raw
        .prepare(
          'select key,value from mcp_records where substr(key,1,?) = ? and (expires_at is null or expires_at > ?) order by key',
        )
        .all(prefix.length, prefix, Date.now()) as { key: string; value: string }[]
    ).map((r) => ({ key: r.key, value: JSON.parse(r.value) as T }));
  }
  prune() {
    this.raw
      .prepare('delete from mcp_records where expires_at is not null and expires_at <= ?')
      .run(Date.now());
  }
}
