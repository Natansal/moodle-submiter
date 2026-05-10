import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, env } from 'prisma/config';

function loadEnvFromCommonLocations(): void {
  const paths = [
    join(process.cwd(), '.env'),
    join(process.cwd(), 'packages/database/.env'),
  ];
  for (const envPath of paths) {
    if (!existsSync(envPath)) continue;
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
    break;
  }
}

loadEnvFromCommonLocations();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
