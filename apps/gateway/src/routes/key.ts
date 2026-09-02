import type { Hono } from "hono";
import type { AppDeps, AppEnv } from "../app.js";
import { microToUsd } from "../accounting/cost.js";

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

    const totals = await deps.store.usage(keyId);

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
        usage: microToUsd(totals.costMicro),
        usage_details: {
          requests: totals.requests,
          prompt_tokens: totals.promptTokens,
          completion_tokens: totals.completionTokens,
        },
      },
    });
  });
}
