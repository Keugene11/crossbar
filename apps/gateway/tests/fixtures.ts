import type { Endpoint } from "../src/registry/catalog.js";

/**
 * One place that knows the shape of an `Endpoint`.
 *
 * Every suite that needs a synthetic endpoint builds it here, so adding a
 * column to the schema is a one-line change rather than a hunt through four
 * near-identical literals.
 */
export function makeEndpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    id: "m::p",
    modelId: "m",
    provider: "p",
    upstreamModelId: "u",
    baseUrl: null,
    pricePromptMicro: 1_000_000,
    priceCompletionMicro: 1_000_000,
    priceCacheReadMicro: null,
    priceCacheWriteMicro: null,
    contextLength: 100_000,
    maxOutputTokens: 4_096,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsReasoning: false,
    unsupportedParams: [],
    quantization: null,
    dataCollection: "deny",
    status: "active",
    priority: 0,
    ...overrides,
  };
}

/** An endpoint priced in whole USD per MTok, for readable cost assertions. */
export function pricedEndpoint(
  usdPrompt: number,
  usdCompletion: number,
  usdCacheRead?: number,
  overrides: Partial<Endpoint> = {},
): Endpoint {
  return makeEndpoint({
    pricePromptMicro: usdPrompt * 1_000_000,
    priceCompletionMicro: usdCompletion * 1_000_000,
    priceCacheReadMicro: usdCacheRead === undefined ? null : usdCacheRead * 1_000_000,
    ...overrides,
  });
}
