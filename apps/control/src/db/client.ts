import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { schema } from "./schema.ts";

/**
 * Dialect-level type so the application works against node-postgres in
 * production and PGlite in tests without knowing which one it got.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDb(databaseUrl: string): { db: Database; close: () => Promise<void> } {
  const pool = new Pool({ connectionString: databaseUrl });
  return { db: drizzle(pool, { schema }) as unknown as Database, close: () => pool.end() };
}
