import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** Process configuration, read once at startup. */

/**
 * Load `.env` before anything reads `process.env`.
 *
 * Without this the documented setup silently fails: you put a provider key in
 * the file the README tells you to, start the gateway, and every request comes
 * back 401 from the provider with nothing to suggest the key was never read.
 *
 * Uses Node's built-in loader rather than a dependency, and never overwrites a
 * variable that is already set -- a real environment beats a checked-out file.
 */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env): void {
  const packageRoot = resolve(import.meta.dirname, "..");
  const candidates = [
    env.CROSSBAR_ENV_FILE,
    join(process.cwd(), ".env"),
    join(packageRoot, ".env"),
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // A malformed file should not stop the gateway from starting.
    }
  }
}

loadDotEnv();

function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export interface Config {
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Bearer keys accepted by the gateway. Empty in test/dev disables auth. */
  apiKeys: string[];
  /**
   * Keys restricted to zero-cost endpoints. Safe to publish -- the restriction
   * is enforced by routing, not by hoping nobody finds the key.
   */
  freeApiKeys: string[];
  /** Unset => embedded PGlite. Set => node-postgres against this URL. */
  databaseUrl: string | undefined;
  /** Directory for the embedded PGlite datadir. */
  pgliteDir: string;
  anthropicApiKey: string | undefined;
  openaiApiKey: string | undefined;
  /** Per-attempt budget for producing the first output chunk, in ms. */
  ttftTimeoutMs: number;
  /** Whole-request budget in ms. */
  requestTimeoutMs: number;
  /** Catalog cache lifetime in ms. */
  catalogTtlMs: number;
  /** Sustained requests per minute per caller. Zero disables the limiter. */
  rateLimitRpm: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const level = env.LOG_LEVEL as Config["logLevel"] | undefined;
  return {
    port: int(env.PORT, 8080),
    logLevel: level ?? "info",
    apiKeys: csv(env.CROSSBAR_API_KEYS),
    freeApiKeys: csv(env.CROSSBAR_FREE_API_KEYS),
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDir: env.CROSSBAR_PGLITE_DIR ?? "./.pglite",
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    ttftTimeoutMs: int(env.CROSSBAR_TTFT_TIMEOUT_MS, 30_000),
    requestTimeoutMs: int(env.CROSSBAR_REQUEST_TIMEOUT_MS, 600_000),
    catalogTtlMs: int(env.CROSSBAR_CATALOG_TTL_MS, 60_000),
    rateLimitRpm: int(env.CROSSBAR_RATE_LIMIT_RPM, 600),
  };
}

export const config = loadConfig();
