import { describe, expect, it } from "vitest";
import { costMicro, microToUsd } from "../../src/accounting/cost.js";
import { toRow } from "../../src/accounting/record.js";
import type { Endpoint } from "../../src/registry/catalog.js";
import type { Usage } from "../../src/schemas/openai.js";

function endpoint(usdPrompt: number, usdCompletion: number, usdCacheRead?: number): Endpoint {
  return {
    id: "m::p",
    modelId: "m",
    provider: "p",
    upstreamModelId: "u",
    baseUrl: null,
    pricePromptMicro: usdPrompt * 1_000_000,
    priceCompletionMicro: usdCompletion * 1_000_000,
    priceCacheReadMicro: usdCacheRead === undefined ? null : usdCacheRead * 1_000_000,
    priceCacheWriteMicro: null,
    contextLength: 1000,
    maxOutputTokens: 100,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsReasoning: false,
    unsupportedParams: [],
    status: "active",
    priority: 0,
  };
}

function usage(prompt: number, completion: number, cached = 0, cacheWrite = 0): Usage {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: cacheWrite },
  };
}

describe("cost", () => {
  it("prices a million tokens at exactly the list rate", () => {
    // $5/MTok in, $25/MTok out.
    expect(costMicro(usage(1_000_000, 0), endpoint(5, 25))).toBe(5_000_000);
    expect(costMicro(usage(0, 1_000_000), endpoint(5, 25))).toBe(25_000_000);
    expect(microToUsd(costMicro(usage(1_000_000, 1_000_000), endpoint(5, 25)))).toBe(30);
  });

  it("bills cached tokens at the cache-read rate, not the prompt rate", () => {
    // 1000 prompt of which 800 cached: 200 @ $5 + 800 @ $0.50.
    const cost = costMicro(usage(1000, 0, 800), endpoint(5, 25, 0.5));
    expect(cost).toBe(200 * 5 + 800 * 0.5);
  });

  it("falls back to the prompt rate when an endpoint publishes no cache price", () => {
    expect(costMicro(usage(1000, 0, 800), endpoint(5, 25))).toBe(1000 * 5);
  });

  it("never counts cached tokens twice", () => {
    // cached is a subset of prompt_tokens, so it must not inflate the total.
    const all = costMicro(usage(1000, 0, 1000), endpoint(5, 25, 0.5));
    expect(all).toBe(1000 * 0.5);
  });

  it("rounds once, at the end", () => {
    // 3 tokens @ $1/MTok = 3 micro-USD; per-component rounding would lose it.
    expect(costMicro(usage(1, 1, 1), endpoint(1, 1, 0.1))).toBe(Math.round(0.1 + 1));
  });

  it("bills cache writes at the cache-write premium", () => {
    // 1000 prompt = 200 fresh + 300 cached read + 500 cache write.
    // $5 in, $0.50 cache read, $6.25 cache write.
    const e = { ...endpoint(5, 25, 0.5), priceCacheWriteMicro: 6.25 * 1_000_000 };
    expect(costMicro(usage(1000, 0, 300, 500), e)).toBe(
      Math.round(200 * 5 + 300 * 0.5 + 500 * 6.25),
    );
  });

  it("treats cache writes as ordinary input when no write rate is published", () => {
    expect(costMicro(usage(1000, 0, 0, 400), endpoint(5, 25, 0.5))).toBe(1000 * 5);
  });

  it("is zero for an empty generation", () => {
    expect(costMicro(usage(0, 0), endpoint(5, 25))).toBe(0);
  });
});

describe("generation rows", () => {
  const draft = {
    id: "gen_1",
    keyId: null,
    appReferer: null,
    appTitle: null,
    requestedModel: "m",
    streamed: false,
    latencyMs: 10,
    ttftMs: 5,
    attempts: [],
  };

  it("bills a successful generation", () => {
    const row = toRow({
      ...draft,
      endpoint: endpoint(5, 25),
      finishReason: "stop",
      usage: usage(1_000_000, 0),
      error: null,
    });
    expect(row.costMicro).toBe(5_000_000);
    expect(row.promptTokens).toBe(1_000_000);
  });

  it("does not bill a failed generation, even with usage attached", () => {
    // A cascade that burned providers before failing must charge nothing.
    const row = toRow({
      ...draft,
      endpoint: endpoint(5, 25),
      finishReason: "error",
      usage: usage(1_000_000, 1_000_000),
      error: { code: "provider_error", status: 502, message: "boom" },
    });
    expect(row.costMicro).toBe(0);
  });

  it("does not bill when no endpoint ever served the request", () => {
    const row = toRow({
      ...draft,
      endpoint: null,
      finishReason: "error",
      usage: null,
      error: { code: "all_providers_failed", status: 502, message: "all failed" },
    });
    expect(row.costMicro).toBe(0);
    expect(row.endpointId).toBeNull();
    expect(row.provider).toBeNull();
  });
});
