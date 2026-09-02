import type { Hono } from "hono";
import type { AppDeps, AppEnv } from "../app.js";
import { CrossbarError } from "../errors.js";
import { microToUsd } from "../accounting/cost.js";
import type { Endpoint, Model } from "../registry/catalog.js";

/** Prices are published in USD per token, matching OpenRouter's model list. */
function usdPerToken(micro: number | null): string | null {
  return micro === null ? null : (microToUsd(micro) / 1_000_000).toFixed(12);
}

function serializeEndpoint(e: Endpoint): Record<string, unknown> {
  return {
    name: `${e.provider} | ${e.upstreamModelId}`,
    provider_name: e.provider,
    context_length: e.contextLength,
    max_completion_tokens: e.maxOutputTokens,
    pricing: {
      prompt: usdPerToken(e.pricePromptMicro),
      completion: usdPerToken(e.priceCompletionMicro),
      input_cache_read: usdPerToken(e.priceCacheReadMicro),
      input_cache_write: usdPerToken(e.priceCacheWriteMicro),
    },
    supported_parameters: {
      tools: e.supportsTools,
      streaming: e.supportsStreaming,
      vision: e.supportsVision,
      reasoning: e.supportsReasoning,
      prompt_caching: e.priceCacheReadMicro !== null,
    },
    unsupported_parameters: e.unsupportedParams,
    quantization: e.quantization,
    data_collection: e.dataCollection,
  };
}

function serializeModel(m: Model, endpoints: Endpoint[]): Record<string, unknown> {
  const cheapest = [...endpoints].sort(
    (a, b) => a.pricePromptMicro + a.priceCompletionMicro - (b.pricePromptMicro + b.priceCompletionMicro),
  )[0];

  return {
    id: m.id,
    name: m.name,
    description: m.description,
    created: Math.floor(m.createdAt.getTime() / 1000),
    context_length: m.contextLength,
    architecture: {
      input_modalities: m.inputModalities,
      output_modalities: m.outputModalities,
    },
    pricing: cheapest
      ? {
          prompt: usdPerToken(cheapest.pricePromptMicro),
          completion: usdPerToken(cheapest.priceCompletionMicro),
        }
      : null,
    endpoints: endpoints.map(serializeEndpoint),
  };
}

export function registerModelRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  /**
   * The catalog listing is identical for every caller and changes only when the
   * snapshot is refreshed, so it is serialized once per snapshot rather than
   * rebuilt -- and served as a pre-rendered string, skipping a full re-encode
   * of every model on each request.
   */
  let cached: { snapshot: unknown; body: string } | undefined;

  app.get("/models", async (c) => {
    const snapshot = await deps.catalog.ensureFresh();

    if (cached?.snapshot !== snapshot) {
      cached = {
        snapshot,
        body: JSON.stringify({
          object: "list",
          data: deps.catalog
            .listModels()
            .map((m) => serializeModel(m, deps.catalog.endpointsFor(m.id))),
        }),
      };
    }
    return c.body(cached.body, 200, { "content-type": "application/json" });
  });

  // Endpoint-level detail for one model, mirroring OpenRouter's shape.
  app.get("/models/:author/:slug/endpoints", async (c) => {
    await deps.catalog.ensureFresh();
    const id = `${c.req.param("author")}/${c.req.param("slug")}`;
    const model = deps.catalog.getModel(id);
    if (!model) {
      throw new CrossbarError({
        status: 404,
        code: "not_found",
        message: `No such model: "${id}"`,
        retryable: false,
      });
    }
    return c.json({
      data: {
        id: model.id,
        name: model.name,
        endpoints: deps.catalog.endpointsFor(id).map(serializeEndpoint),
      },
    });
  });

  // Model ids carry a slash, so the path has to be matched in two segments.
  app.get("/models/:author/:slug", async (c) => {
    await deps.catalog.ensureFresh();
    const id = `${c.req.param("author")}/${c.req.param("slug")}`;
    const model = deps.catalog.getModel(id);
    if (!model) {
      throw new CrossbarError({
        status: 404,
        code: "not_found",
        message: `No such model: "${id}"`,
        retryable: false,
      });
    }
    return c.json({ data: serializeModel(model, deps.catalog.endpointsFor(id)) });
  });
}
