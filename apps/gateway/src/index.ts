import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { getDb } from "./db/client.js";
import { seedCatalog } from "./db/seed.js";
import { AnthropicAdapter } from "./providers/anthropic/index.js";
import { OpenAIAdapter } from "./providers/openai/index.js";
import { ProviderRegistry } from "./providers/types.js";
import { Catalog } from "./registry/catalog.js";
import { StatsTracker } from "./routing/stats.js";

const handle = getDb();
try {
  await handle.migrate();
} catch (err) {
  if (handle.driver === "pglite") {
    // PGlite is single-writer: a second process on the same datadir aborts
    // inside wasm with no usable message of its own.
    console.error(
      [
        `[crossbar] could not open the embedded database at ${config.pgliteDir}.`,
        "  PGlite allows one process per datadir -- stop any other crossbar instance,",
        "  or set DATABASE_URL to run against a real Postgres server.",
      ].join("\n"),
    );
  }
  throw err;
}

const catalog = new Catalog(handle.db, config.catalogTtlMs);
await catalog.refresh();

// A gateway with no catalog cannot route anything, and with PGlite the server
// holds the only writable handle -- so `pnpm db:seed` could not fix it from
// another process. Seeding here is an idempotent upsert of a static catalog.
if (catalog.snapshot.models.length === 0) {
  console.log("[crossbar] empty catalog, seeding...");
  await seedCatalog(handle.db);
  await catalog.refresh();
}

const providers = new ProviderRegistry()
  .register(new AnthropicAdapter({ apiKey: config.anthropicApiKey }))
  .register(new OpenAIAdapter({ apiKey: config.openaiApiKey }));

const app = createApp({
  db: handle.db,
  catalog,
  providers,
  stats: new StatsTracker(),
  apiKeys: config.apiKeys,
  ttftTimeoutMs: config.ttftTimeoutMs,
  attemptTimeoutMs: config.requestTimeoutMs,
  rateLimitRpm: config.rateLimitRpm,
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const auth = config.apiKeys.length ? `${config.apiKeys.length} key(s)` : "DISABLED";
  const limit = config.rateLimitRpm > 0 ? `${config.rateLimitRpm}/min` : "off";
  console.log(
    `[crossbar] listening on http://localhost:${info.port}  ` +
      `db=${handle.driver}  models=${catalog.snapshot.models.length}  ` +
      `auth=${auth}  ratelimit=${limit}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
