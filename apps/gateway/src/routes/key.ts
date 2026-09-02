import { count, eq, sql, sum } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppDeps, AppEnv } from "../app.js";
import { microToUsd } from "../accounting/cost.js";
import { generations } from "../db/schema.js";

/**
 * Information about the calling key, mirroring OpenRouter's `/api/v1/key`.
 *
 * Usage is aggregated over this key's own generations only -- the same scoping
 * rule as `/v1/generation`, so the endpoint cannot be used to learn anything
 * about other callers' traffic.
 */
export function registerKeyRoute(app: Hono<AppEnv>, deps: AppDeps): void {
  app.get("/key", async (c) => {
    const keyId = c.get("keyId");

    const scoped = keyId === null ? undefined : eq(generations.keyId, keyId);
    const [totals] = await deps.db
      .select({
        requests: count(),
        costMicro: sum(generations.costMicro).mapWith(Number),
        promptTokens: sum(generations.promptTokens).mapWith(Number),
        completionTokens: sum(generations.completionTokens).mapWith(Number),
      })
      .from(generations)
      .where(scoped ?? sql`true`);

    return c.json({
      data: {
        label: keyId,
        // No credit system in this build; the field is present so clients
        // written against OpenRouter do not have to special-case its absence.
        limit: null,
        limit_remaining: null,
        is_free_tier: false,
        rate_limit: {
          requests: deps.rateLimitRpm ?? 0,
          interval: "1m",
        },
        usage: microToUsd(totals?.costMicro ?? 0),
        usage_details: {
          requests: totals?.requests ?? 0,
          prompt_tokens: totals?.promptTokens ?? 0,
          completion_tokens: totals?.completionTokens ?? 0,
        },
      },
    });
  });
}
