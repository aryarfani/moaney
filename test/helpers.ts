import { eq } from 'drizzle-orm';
import { openDb } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { categories, wallets } from '../src/db/schema.js';

export function freshDb() {
  const handle = openDb(':memory:');
  seed(handle.db);
  const w = (name: string) => handle.db.select().from(wallets).where(eq(wallets.name, name)).get()!.id;
  const c = (name: string) => handle.db.select().from(categories).where(eq(categories.name, name)).get()!.id;
  return { ...handle, w, c };
}
