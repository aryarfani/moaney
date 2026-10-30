import fs from 'node:fs';
import path from 'node:path';

/** Project root: the nearest ancestor with a package.json, so it works from src/ and from dist/src/. */
function findRoot(): string {
  let dir = import.meta.dirname;
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error('package.json not found');
    dir = up;
  }
  return dir;
}

export const ROOT = findRoot();
export const MIGRATIONS_DIR = path.join(ROOT, 'drizzle');
export const WEB_DIR = path.join(ROOT, 'dist', 'web');
