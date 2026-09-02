import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { join } from "node:path";
import { config } from "../config.js";
import * as schema from "./schema.js";

/**
 * Both drivers expose the same query surface, so the rest of the app is typed
 * against the node-postgres shape and the PGlite handle is widened to match.
 */
export type DB = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: DB;
  driver: "pglite" | "node-postgres";
  /** Applies every pending migration from src/db/migrations. */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export const MIGRATIONS_FOLDER = join(import.meta.dirname, "migrations");

export interface CreateDbOptions {
  /** Overrides config. Pass ":memory:" for an ephemeral PGlite instance. */
  url?: string | undefined;
}

/**
 * `DATABASE_URL` selects node-postgres. Unset selects PGlite -- real Postgres
 * compiled to WASM, so the same SQL and the same migrations run in tests and in
 * local dev without a daemon.
 */
export function createDb(opts: CreateDbOptions = {}): DbHandle {
  const url = opts.url ?? config.databaseUrl;

  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const pool = new Pool({ connectionString: url });
    const db = drizzleNodePg(pool, { schema });
    return {
      db,
      driver: "node-postgres",
      migrate: () => migrateNodePg(db, { migrationsFolder: MIGRATIONS_FOLDER }),
      close: () => pool.end(),
    };
  }

  const client = new PGlite(url === ":memory:" || !url ? undefined : url);
  const pglite = drizzlePglite(client, { schema });
  return {
    db: pglite as unknown as DB,
    driver: "pglite",
    migrate: () => migratePglite(pglite, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => client.close(),
  };
}

let singleton: DbHandle | undefined;

/** Process-wide handle for the server. Tests build their own via `createDb`. */
export function getDb(): DbHandle {
  singleton ??= createDb({ url: config.databaseUrl ?? config.pgliteDir });
  return singleton;
}
