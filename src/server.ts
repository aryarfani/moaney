import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { seed } from './db/seed.js';
import { scheduleBackups } from './jobs/backup.js';

function loadDotenv(file = '.env') {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadDotenv();
const config = loadConfig();
if (!config.OWNER_PASSWORD_HASH) console.warn('OWNER_PASSWORD_HASH is empty: nobody can sign in. Run `npm run hash-password`.');

const handle = openDb(path.join(config.DATA_DIR, 'moaney.db'));
seed(handle.db);
scheduleBackups(handle.raw, config.BACKUP_DIR, config.BACKUP_KEEP);

const server = createApp(handle, config).listen(config.PORT, config.HOST, () => {
  console.log(JSON.stringify({ level: 'info', msg: `moaney listening on ${config.HOST}:${config.PORT}` }));
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => { handle.raw.close(); process.exit(0); }));
}
