import type { Hono } from "hono";
import type { AppDeps, AppEnv } from "../app.js";
import { microToUsd } from "../accounting/cost.js";
import { CrossbarError } from "../errors.js";

const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;

/**
 * Daily usage rollup, mirroring OpenRouter's activity export.
 *
 * Aggregated in SQL rather than by loading rows: a busy key can accumulate
 * millions of generations, and pulling them into memory to sum four columns
 * would turn a reporting endpoint into an outage.
 *
 * Scoped to the calling key, like every other read here.
 */
export function registerActivityRoute(app: Hono<AppEnv>, deps: AppDeps): void {
  app.get("/activity", async (c) => {
    const raw = c.req.query("days");
    const days = raw === undefined ? DEFAULT_DAYS : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      throw new CrossbarError({
        status: 400,
        code: "invalid_request",
        message: `Query parameter \`days\` must be an integer between 1 and ${MAX_DAYS}`,
        retryable: false,
      });
    }

    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await deps.store.activity(c.get("keyId") ?? null, since);

    return c.json({
      object: "list",
      data: rows.map((r) => ({
        date: r.date,
        model: r.model,
        provider_name: r.provider,
        requests: r.requests,
        errors: r.errors,
        prompt_tokens: r.promptTokens,
        completion_tokens: r.completionTokens,
        usage: microToUsd(r.costMicro),
      })),
    });
  });
}
