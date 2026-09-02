import { describe, expect, it } from "vitest";
import type { Endpoint } from "../../src/registry/catalog.js";
import { filterEndpoints, orderEndpoints, priceWeightedOrder } from "../../src/routing/select.js";
import { StatsTracker } from "../../src/routing/stats.js";
import { defaultProviderPreferences, type ProviderPreferences } from "../../src/schemas/routing.js";
import { makeEndpoint } from "../fixtures.js";

function ep(provider: string, usdPrompt: number, usdCompletion = usdPrompt): Endpoint {
  return makeEndpoint({
    id: `m::${provider}`,
    provider,
    upstreamModelId: `${provider}-model`,
    pricePromptMicro: usdPrompt * 1_000_000,
    priceCompletionMicro: usdCompletion * 1_000_000,
  });
}

const prefs = (o: Partial<ProviderPreferences> = {}): ProviderPreferences => ({
  ...defaultProviderPreferences,
  ...o,
});

/** Deterministic uniform sampler over [0,1). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe("filtering", () => {
  const all = [ep("a", 1), ep("b", 3), ep("c", 9)];

  it("only acts as an allowlist", () => {
    expect(filterEndpoints(all, prefs({ only: ["a", "c"] })).map((e) => e.provider)).toEqual(["a", "c"]);
  });

  it("ignore removes providers", () => {
    expect(filterEndpoints(all, prefs({ ignore: ["b"] })).map((e) => e.provider)).toEqual(["a", "c"]);
  });

  it("max_price drops endpoints above the ceiling", () => {
    expect(
      filterEndpoints(all, prefs({ max_price: { prompt: 3 } })).map((e) => e.provider),
    ).toEqual(["a", "b"]);
  });
});

describe("inverse-square price weighting", () => {
  it("favours a $1 endpoint over a $3 endpoint by roughly 9x", () => {
    // The documented default: weight is 1/price^2, so 3x the price is ~1/9 the
    // chance of going first. Sampling, not asserting an exact ratio.
    const endpoints = [ep("cheap", 0.5), ep("dear", 1.5)];
    const random = seeded(42);
    let cheapFirst = 0;
    const runs = 20_000;

    for (let i = 0; i < runs; i++) {
      if (priceWeightedOrder(endpoints, random)[0]?.provider === "cheap") cheapFirst++;
    }

    const ratio = cheapFirst / (runs - cheapFirst);
    expect(ratio).toBeGreaterThan(7.5);
    expect(ratio).toBeLessThan(10.5);
  });

  it("returns a complete ordering, so the tail is the fallback chain", () => {
    const endpoints = [ep("a", 1), ep("b", 2), ep("c", 3)];
    const order = priceWeightedOrder(endpoints, seeded(7));
    expect(order).toHaveLength(3);
    expect(new Set(order.map((e) => e.provider))).toEqual(new Set(["a", "b", "c"]));
  });

  it("does not divide by zero on a free endpoint", () => {
    const order = priceWeightedOrder([ep("free", 0), ep("paid", 5)], seeded(1));
    expect(order[0]?.provider).toBe("free");
  });
});

describe("explicit ordering", () => {
  const all = [ep("a", 1), ep("b", 3), ep("c", 9)];

  it("sort=price is deterministic and cheapest-first", () => {
    const ctx = { stats: new StatsTracker(), random: () => 0.999 };
    expect(orderEndpoints(all, prefs({ sort: "price" }), ctx).map((e) => e.provider)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("sort=latency puts measured endpoints ahead of unmeasured ones", () => {
    const stats = new StatsTracker();
    stats.recordSuccess("m::c", { ttftMs: 100 });
    stats.recordSuccess("m::a", { ttftMs: 900 });
    const ctx = { stats, random: () => 0 };
    // b has no samples, so it sorts last rather than pretending to be instant.
    expect(orderEndpoints(all, prefs({ sort: "latency" }), ctx).map((e) => e.provider)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("sort=throughput prefers the fastest measured endpoint", () => {
    const stats = new StatsTracker();
    stats.recordSuccess("m::a", { tokensPerSecond: 10 });
    stats.recordSuccess("m::b", { tokensPerSecond: 80 });
    const ctx = { stats, random: () => 0 };
    expect(orderEndpoints(all, prefs({ sort: "throughput" }), ctx).map((e) => e.provider)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("order names preferences, keeping unnamed providers as fallbacks", () => {
    const ctx = { stats: new StatsTracker(), random: () => 0 };
    expect(orderEndpoints(all, prefs({ order: ["c", "a"] }), ctx).map((e) => e.provider)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});

describe("outage deprioritisation", () => {
  it("moves a recently failed endpoint behind healthy ones without removing it", () => {
    let clock = 1_000_000;
    const stats = new StatsTracker({ outageWindowMs: 30_000, now: () => clock });
    stats.recordFailure("m::a"); // 'a' is the cheapest, and would normally win

    const ctx = { stats, random: () => 0 };
    const order = orderEndpoints([ep("a", 1), ep("b", 3)], prefs(), ctx);
    expect(order.map((e) => e.provider)).toEqual(["b", "a"]);

    // Once the window lapses the cheap endpoint is trusted again.
    clock += 31_000;
    expect(orderEndpoints([ep("a", 1), ep("b", 3)], prefs(), ctx).map((e) => e.provider)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("policy filters", () => {
  it("data_collection:deny removes providers that may train on prompts", () => {
    // A privacy constraint removes rather than deprioritises: routing to a
    // training provider would violate the caller's intent even if every
    // alternative is down.
    const endpoints = [
      makeEndpoint({ id: "m::trains", provider: "trains", dataCollection: "allow" }),
      makeEndpoint({ id: "m::private", provider: "private", dataCollection: "deny" }),
    ];

    expect(
      filterEndpoints(endpoints, prefs({ data_collection: "deny" })).map((e) => e.provider),
    ).toEqual(["private"]);
    // The default expresses no preference, so both stay.
    expect(filterEndpoints(endpoints, prefs()).map((e) => e.provider)).toEqual([
      "trains",
      "private",
    ]);
  });

  it("quantizations restricts to the named weight formats", () => {
    const endpoints = [
      makeEndpoint({ id: "m::a", provider: "a", quantization: "fp8" }),
      makeEndpoint({ id: "m::b", provider: "b", quantization: "bf16" }),
      makeEndpoint({ id: "m::c", provider: "c", quantization: null }),
    ];

    expect(
      filterEndpoints(endpoints, prefs({ quantizations: ["bf16"] })).map((e) => e.provider),
    ).toEqual(["b"]);
    // An endpoint that publishes no quantization cannot be shown to satisfy
    // the constraint, so it is excluded rather than assumed acceptable.
    expect(
      filterEndpoints(endpoints, prefs({ quantizations: ["fp8", "bf16"] })).map((e) => e.provider),
    ).toEqual(["a", "b"]);
  });
});
