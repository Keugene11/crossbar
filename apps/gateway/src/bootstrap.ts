import { createApp, type App, type AppDeps } from "./app.js";
import { config, type Config } from "./config.js";
import { AnthropicAdapter } from "./providers/anthropic/index.js";
import { OpenAIAdapter } from "./providers/openai/index.js";
import { ProviderRegistry } from "./providers/types.js";
import { Catalog, staticSource, type Endpoint, type Model, type Provider } from "./registry/catalog.js";
import type { DbHandle } from "./db/client.js";
import { catalogSeed, endpointId, providerSeed, toMicro } from "./registry/seed.js";
import { StatsTracker } from "./routing/stats.js";
import { MemoryStore } from "./store/memory.js";
import type { GenerationStore } from "./store/types.js";

/**
 * One wiring path for every deployment target.
 *
 * A durable deployment gets Postgres (or embedded PGlite); a stateless one --
 * serverless, where there is no writable disk and no connection to pool --
 * gets the compiled-in catalog and an in-memory ledger. Routing, translation,
 * failover and accounting are identical either way, because none of them ever
 * touch storage directly.
 */
export interface Bootstrapped {
  app: App;
  store: GenerationStore;
  catalog: Catalog;
  db: DbHandle | undefined;
  close(): Promise<void>;
}

function buildProviders(cfg: Config): ProviderRegistry {
  return new ProviderRegistry()
    .register(new AnthropicAdapter({ apiKey: cfg.anthropicApiKey }))
    .register(new OpenAIAdapter({ apiKey: cfg.openaiApiKey }));
}

/** Materialise the compiled-in seed as catalog rows, with no database. */
export function seedSnapshot(): { models: Model[]; endpoints: Endpoint[]; providers: Provider[] } {
  const now = new Date();

  const models: Model[] = catalogSeed.map((m) => {
    const [author, ...rest] = m.id.split("/");
    return {
      id: m.id,
      author: author ?? "",
      slug: rest.join("/"),
      name: m.name,
      description: m.description ?? null,
      contextLength: m.contextLength,
      inputModalities: m.inputModalities,
      outputModalities: m.outputModalities,
      createdAt: now,
    };
  });

  const endpoints: Endpoint[] = catalogSeed.flatMap((m) =>
    m.endpoints.map((e) => ({
      id: endpointId(m.id, e.provider),
      modelId: m.id,
      provider: e.provider,
      upstreamModelId: e.upstreamModelId,
      baseUrl: null,
      pricePromptMicro: toMicro(e.pricePrompt),
      priceCompletionMicro: toMicro(e.priceCompletion),
      priceCacheReadMicro: e.priceCacheRead === undefined ? null : toMicro(e.priceCacheRead),
      priceCacheWriteMicro: e.priceCacheWrite === undefined ? null : toMicro(e.priceCacheWrite),
      contextLength: e.contextLength ?? m.contextLength,
      maxOutputTokens: e.maxOutputTokens,
      supportsTools: e.supportsTools ?? true,
      supportsStreaming: true,
      supportsVision: e.supportsVision ?? false,
      supportsReasoning: e.supportsReasoning ?? false,
      unsupportedParams: e.unsupportedParams ?? [],
      quantization: e.quantization ?? null,
      dataCollection: e.dataCollection ?? "deny",
      status: "active" as const,
      priority: e.priority ?? 0,
    })),
  );

  const providers: Provider[] = providerSeed.map((p) => ({
    id: p.id,
    name: p.name,
    mayTrainOnData: p.mayTrainOnData,
    privacyPolicyUrl: p.privacyPolicyUrl ?? null,
    termsUrl: p.termsUrl ?? null,
    statusPageUrl: p.statusPageUrl ?? null,
  }));

  return { models, endpoints, providers };
}

function commonDeps(cfg: Config): Omit<AppDeps, "store" | "catalog" | "db"> {
  return {
    providers: buildProviders(cfg),
    stats: new StatsTracker(),
    apiKeys: cfg.apiKeys,
    ttftTimeoutMs: cfg.ttftTimeoutMs,
    attemptTimeoutMs: cfg.requestTimeoutMs,
    rateLimitRpm: cfg.rateLimitRpm,
  };
}

/** Stateless: no database, no disk, no migrations. Suitable for serverless. */
export async function bootstrapStateless(cfg: Config = config): Promise<Bootstrapped> {
  const { models, endpoints, providers } = seedSnapshot();
  const catalog = new Catalog(staticSource(models, endpoints, providers), cfg.catalogTtlMs);
  await catalog.refresh();

  const store = new MemoryStore();
  const app = createApp({ ...commonDeps(cfg), catalog, store });

  return { app, store, catalog, db: undefined, close: async () => {} };
}

/**
 * Durable: Postgres when DATABASE_URL is set, embedded PGlite otherwise.
 *
 * The database modules are imported dynamically so the stateless path never
 * loads them. That is not micro-optimisation: PGlite ships a multi-megabyte
 * WASM payload that a serverless bundle would otherwise carry and a cold start
 * would otherwise pay for, to reach code that cannot run there anyway.
 */
export async function bootstrapDurable(cfg: Config = config): Promise<Bootstrapped> {
  const [{ createDb }, { seedCatalog }, { PostgresStore }] = await Promise.all([
    import("./db/client.js"),
    import("./db/seed.js"),
    import("./store/postgres.js"),
  ]);

  const handle = createDb({ url: cfg.databaseUrl ?? cfg.pgliteDir });
  await handle.migrate();

  const catalog = new Catalog(handle.db, cfg.catalogTtlMs);
  await catalog.refresh();

  // A gateway with no catalog cannot route anything, and with PGlite the
  // server holds the only writable handle -- so `pnpm db:seed` could not fix
  // it from another process. Seeding here is an idempotent upsert.
  if (catalog.snapshot.models.length === 0) {
    console.log("[crossbar] empty catalog, seeding...");
    await seedCatalog(handle.db);
    await catalog.refresh();
  }

  const store = new PostgresStore(handle.db);
  const app = createApp({ ...commonDeps(cfg), catalog, store, db: handle.db });

  return { app, store, catalog, db: handle, close: () => handle.close() };
}

/**
 * `CROSSBAR_STATELESS=1` forces stateless mode. It is also the default on a
 * serverless platform, where a file-backed embedded database cannot work:
 * there is no persistent writable disk, and PGlite allows one writer.
 */
export function shouldRunStateless(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CROSSBAR_STATELESS === "1") return true;
  if (env.CROSSBAR_STATELESS === "0") return false;
  return Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME) && !env.DATABASE_URL;
}

export async function bootstrap(cfg: Config = config): Promise<Bootstrapped> {
  return shouldRunStateless() ? bootstrapStateless(cfg) : bootstrapDurable(cfg);
}
