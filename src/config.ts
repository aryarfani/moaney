import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8790),
  DATA_DIR: z.string().default('./data'),
  BACKUP_DIR: z.string().default('./data/backups'),
  BACKUP_KEEP: z.coerce.number().int().positive().default(14),
  BEHIND_TLS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  OWNER_PASSWORD_HASH: z.string().default(''),
  MCP_PUBLIC_URL: z.string().default('').refine((s) => {
    if (!s) return true;
    try {
      const u = new URL(s);
      return !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' &&
        (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)));
    } catch { return false; }
  }, 'MCP_PUBLIC_URL must be an HTTPS origin (HTTP allowed only on loopback)').transform((s) => s ? new URL(s).origin : ''),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
