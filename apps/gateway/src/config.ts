/** Process configuration, read once at startup. */

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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const level = env.LOG_LEVEL as Config["logLevel"] | undefined;
  return {
    port: int(env.PORT, 8080),
    logLevel: level ?? "info",
    apiKeys: csv(env.CROSSBAR_API_KEYS),
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDir: env.CROSSBAR_PGLITE_DIR ?? "./.pglite",
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    ttftTimeoutMs: int(env.CROSSBAR_TTFT_TIMEOUT_MS, 30_000),
    requestTimeoutMs: int(env.CROSSBAR_REQUEST_TIMEOUT_MS, 600_000),
    catalogTtlMs: int(env.CROSSBAR_CATALOG_TTL_MS, 60_000),
  };
}

export const config = loadConfig();
