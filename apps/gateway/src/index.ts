import { serve } from "@hono/node-server";
import { bootstrap, shouldRunStateless } from "./bootstrap.js";
import { config } from "./config.js";

let started;
try {
  started = await bootstrap();
} catch (err) {
  if (!shouldRunStateless() && !config.databaseUrl) {
    // PGlite is single-writer: a second process on the same datadir aborts
    // inside wasm with no usable message of its own.
    console.error(
      [
        `[crossbar] could not open the embedded database at ${config.pgliteDir}.`,
        "  PGlite allows one process per datadir -- stop any other crossbar instance,",
        "  set DATABASE_URL to run against a real Postgres server,",
        "  or set CROSSBAR_STATELESS=1 to run without persistence.",
      ].join("\n"),
    );
  }
  throw err;
}

const { app, store, catalog, db } = started;

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const auth = config.apiKeys.length ? `${config.apiKeys.length} key(s)` : "DISABLED";
  const limit = config.rateLimitRpm > 0 ? `${config.rateLimitRpm}/min` : "off";
  const persistence = store.durable ? (db?.driver ?? "postgres") : "memory (not durable)";
  console.log(
    `[crossbar] listening on http://localhost:${info.port}  ` +
      `store=${persistence}  models=${catalog.snapshot.models.length}  ` +
      `auth=${auth}  ratelimit=${limit}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void started.close().finally(() => process.exit(0));
  });
}
