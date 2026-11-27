import { fileURLToPath } from 'node:url';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema.js';

export type Schema = typeof schema;
export type Database = PgDatabase<PgQueryResultHKT, Schema>;

export interface DatabaseHandle {
  db: Database;
  driver: 'pg' | 'pglite';
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Hosted Postgres URLs (e.g. Neon) may carry libpq-only params such as `channel_binding` that
 * node-postgres does not understand; drop them and keep everything else (incl. `sslmode`).
 */
export function normalizePgUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('channel_binding');
    return parsed.toString();
  } catch {
    return url;
  }
}

export async function createDatabase(opts: { driver: 'pg' | 'pglite'; url?: string; dataDir?: string }): Promise<DatabaseHandle> {
  if (opts.driver === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite/vector');
    const client = await PGlite.create({ dataDir: opts.dataDir, extensions: { vector } });
    const db = drizzlePglite(client, { schema });
    return {
      db: db as unknown as Database,
      driver: 'pglite',
      migrate: () => migratePglite(db, { migrationsFolder }),
      ping: async () => {
        await client.query('select 1');
        return true;
      },
      close: () => client.close(),
    };
  }

  const pool = new pg.Pool({ connectionString: normalizePgUrl(opts.url), max: 10 });
  const db = drizzlePg(pool, { schema });
  return {
    db: db as unknown as Database,
    driver: 'pg',
    migrate: () => migratePg(db, { migrationsFolder }),
    ping: async () => {
      await db.execute(sql`select 1`);
      return true;
    },
    close: () => pool.end(),
  };
}
