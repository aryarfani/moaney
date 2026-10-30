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
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
