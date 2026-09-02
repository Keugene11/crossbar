import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AuthVariables } from "./auth.js";
import { auth } from "./auth.js";
import { createRateLimiter, rateLimit } from "./rate-limit.js";
import type { DB } from "./db/client.js";
import { CrossbarError, toErrorEnvelope } from "./errors.js";
import type { ProviderRegistry } from "./providers/types.js";
import type { Catalog } from "./registry/catalog.js";
import type { StatsTracker } from "./routing/stats.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerGenerationRoute } from "./routes/generation.js";
import { registerKeyRoute } from "./routes/key.js";
import { registerModelRoutes } from "./routes/models.js";

/**
 * Largest request body accepted.
 *
 * Generous enough for long conversations with base64 images, small enough that
 * an unauthenticated flood cannot exhaust memory before auth even runs.
 */
export const MAX_BODY_BYTES = 24 * 1024 * 1024;

export interface AppDeps {
  db: DB;
  catalog: Catalog;
  providers: ProviderRegistry;
  stats: StatsTracker;
  apiKeys: string[];
  ttftTimeoutMs: number;
  attemptTimeoutMs: number;
  /** Requests per minute per caller. Zero disables the limiter. */
  rateLimitRpm?: number;
  /** Injected for reproducible routing in tests. */
  random?: () => number;
}

export interface AppVariables extends AuthVariables {
  /** Set by the chat route so error responses can still be traced. */
  generationId?: string;
}

export type AppEnv = { Variables: AppVariables };
export type App = Hono<AppEnv>;

export function createApp(deps: AppDeps): App {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    const { status, body } = toErrorEnvelope(err);
    // Failures are traceable too: the id is on the response even when no
    // endpoint ever produced output, so /v1/generation still explains why.
    const genId = c.get("generationId");
    const headers: Record<string, string> = {};
    if (genId) headers["x-crossbar-generation-id"] = genId;
    if (body.error.metadata?.attempts) {
      headers["x-crossbar-attempts"] = String(body.error.metadata.attempts.length);
    }

    // 499 is not a real HTTP status -- the client is already gone, so the body
    // goes nowhere; 499 exists only for the generation record.
    if (status === 499) return c.body(null, 499 as never, headers);
    return c.json(body, status as never, headers);
  });

  app.notFound((c) =>
    c.json(
      toErrorEnvelope(
        new CrossbarError({
          status: 404,
          code: "not_found",
          message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}`,
          retryable: false,
        }),
      ).body,
      404,
    ),
  );

  // Liveness AND readiness: a gateway that cannot reach its catalog store is
  // not ready to route, and reporting "ok" would keep it in a load balancer
  // pool while every request failed.
  app.get("/health", async (c) => {
    const models = deps.catalog.snapshot.models.length;
    let database: "ok" | "unreachable" = "ok";
    try {
      await deps.db.execute(sql`select 1`);
    } catch {
      database = "unreachable";
    }

    const healthy = database === "ok" && models > 0;
    return c.json(
      {
        status: healthy ? "ok" : "degraded",
        database,
        models,
        providers: deps.providers.ids(),
        uptime_s: Math.floor(process.uptime()),
      },
      healthy ? 200 : 503,
    );
  });

  const v1 = new Hono<AppEnv>();
  // Body limit runs before auth: rejecting an oversized body must not require
  // buffering it first, and must not depend on the caller being authenticated.
  v1.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          toErrorEnvelope(
            new CrossbarError({
              status: 413,
              code: "invalid_request",
              message: `Request body exceeds the ${MAX_BODY_BYTES} byte limit`,
              retryable: false,
            }),
          ).body,
          413,
        ),
    }),
  );
  v1.use("*", auth(deps.apiKeys));
  // After auth, so the bucket is keyed by the authenticated caller rather than
  // by a header they control.
  v1.use("*", rateLimit(createRateLimiter({ requestsPerMinute: deps.rateLimitRpm ?? 0 })));

  registerModelRoutes(v1, deps);
  registerChatRoute(v1, deps);
  registerGenerationRoute(v1, deps);
  registerKeyRoute(v1, deps);

  app.route("/v1", v1);
  // OpenRouter serves its API under /api/v1; accepting both means a client can
  // repoint at crossbar by changing the host alone.
  app.route("/api/v1", v1);
  return app;
}
