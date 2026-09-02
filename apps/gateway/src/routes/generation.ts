import type { Hono } from "hono";
import type { AppDeps, AppEnv } from "../app.js";
import { microToUsd } from "../accounting/cost.js";
import { CrossbarError } from "../errors.js";

export function registerGenerationRoute(app: Hono<AppEnv>, deps: AppDeps): void {
  app.get("/generation", async (c) => {
    const id = c.req.query("id");
    if (!id) {
      throw new CrossbarError({
        status: 400,
        code: "invalid_request",
        message: "Query parameter `id` is required",
        retryable: false,
      });
    }

    // Scope to the calling key. Generation ids travel in response headers,
    // logs, and proxies, so treating one as a bearer capability would let any
    // leaked id read another tenant's routing and spend history. 404 rather
    // than 403: a distinct status would confirm the id exists.
    const row = await deps.store.get(id, c.get("keyId") ?? null);
    if (!row) {
      throw new CrossbarError({
        status: 404,
        code: "not_found",
        message: `No such generation: "${id}"`,
        retryable: false,
      });
    }

    return c.json({
      data: {
        id: row.id,
        created_at: row.createdAt.toISOString(),
        requested_model: row.requestedModel,
        model: row.modelId,
        provider_name: row.provider,
        endpoint_id: row.endpointId,
        streamed: row.streamed,
        finish_reason: row.finishReason,
        tokens_prompt: row.promptTokens,
        tokens_completion: row.completionTokens,
        tokens_reasoning: row.reasoningTokens,
        tokens_cached: row.cachedTokens,
        total_cost: microToUsd(row.costMicro),
        latency_ms: row.latencyMs,
        ttft_ms: row.ttftMs,
        // The full cascade, including endpoints that failed before this one won.
        attempts: row.attempts,
        error: row.error,
      },
    });
  });
}
