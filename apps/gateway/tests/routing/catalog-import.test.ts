import { describe, expect, it } from "vitest";
import { catalogSeed, catalogSource, providerSeed } from "../../src/registry/seed.js";
import { normalize } from "../../src/registry/sync.js";
import { COMPATIBLE_PROVIDERS } from "../../src/providers/compatible.js";

describe("imported catalog", () => {
  it("carries a real catalog, not a handful of examples", () => {
    expect(catalogSeed.length).toBeGreaterThan(200);
    expect(new Set(catalogSeed.map((m) => m.id.split("/")[0])).size).toBeGreaterThan(20);
  });

  it("records where the data came from and when", () => {
    // Prices go stale; provenance is what makes that checkable.
    expect(catalogSource.source).toMatch(/^https:\/\//);
    expect(Number.isNaN(Date.parse(catalogSource.fetchedAt))).toBe(false);
  });

  it("gives every model at least one endpoint with sane pricing", () => {
    for (const m of catalogSeed) {
      if (m.id === "crossbar/auto") continue; // resolved at request time
      expect(m.endpoints.length, m.id).toBeGreaterThan(0);
      for (const e of m.endpoints) {
        expect(e.pricePrompt, `${m.id} prompt`).toBeGreaterThanOrEqual(0);
        expect(e.priceCompletion, `${m.id} completion`).toBeGreaterThanOrEqual(0);
        // Per-MTok, so a sane ceiling catches a units mistake immediately.
        expect(e.pricePrompt, `${m.id} prompt units`).toBeLessThan(10_000);
        expect(e.maxOutputTokens, `${m.id} max output`).toBeGreaterThan(0);
      }
    }
  });

  it("puts the first-party endpoint ahead of the aggregator on flagships", () => {
    // Direct is cheaper and hand-verified; the aggregator is the fallback.
    const opus = catalogSeed.find((m) => m.id === "anthropic/claude-opus-5");
    expect(opus?.endpoints.map((e) => e.provider)).toEqual(["anthropic", "openrouter"]);
  });

  it("keeps the built-in demo model reachable", () => {
    const echo = catalogSeed.find((m) => m.id === "crossbar/echo");
    expect(echo?.endpoints[0]?.provider).toBe("crossbar");
    expect(echo?.endpoints[0]?.pricePrompt).toBe(0);
  });

  it("lists a provider for every endpoint in the catalog", () => {
    const known = new Set(providerSeed.map((p) => p.id));
    for (const m of catalogSeed) {
      for (const e of m.endpoints) expect(known.has(e.provider), `${m.id} -> ${e.provider}`).toBe(true);
    }
  });

  it("registers every compatible provider in the directory", () => {
    const listed = new Set(providerSeed.map((p) => p.id));
    for (const p of COMPATIBLE_PROVIDERS) expect(listed.has(p.id), p.id).toBe(true);
  });
});

describe("normalising the upstream feed", () => {
  const raw = [
    {
      id: "vendor/model",
      name: "Vendor: Model",
      description: "First line.\nSecond line that should be dropped.",
      context_length: 128_000,
      top_provider: { max_completion_tokens: 4096 },
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" },
      supported_parameters: ["tools", "reasoning"],
    },
    // Billing variants duplicate a model already present.
    { id: "vendor/model:batch", name: "batch", pricing: { prompt: "0", completion: "0" } },
    // Unpriced entries cannot be routed or billed.
    { id: "vendor/unpriced", name: "no price" },
    // -1 is a sentinel for "varies", not a price. Left in, it reads as cheaper
    // than free: weighting would send everything there and bill negatives.
    { id: "vendor/varies", name: "varies", pricing: { prompt: "-1", completion: "-1" } },
  ];

  it("keeps priced models and drops variants, unpriced and sentinel entries", () => {
    const out = normalize(raw);
    expect(out.map((m) => m.id)).toEqual(["vendor/model"]);
  });

  it("carries pricing, capabilities and modalities across", () => {
    const [m] = normalize(raw);
    expect(m?.pricePrompt).toBe(0.000001);
    expect(m?.priceCacheRead).toBe(0.0000001);
    expect(m?.supportsTools).toBe(true);
    expect(m?.supportsReasoning).toBe(true);
    expect(m?.inputModalities).toContain("image");
  });

  it("trims descriptions to the first line", () => {
    const [m] = normalize(raw);
    expect(m?.description).toBe("First line.");
  });

  it("returns a stable order regardless of upstream ordering", () => {
    const a = normalize([...raw].reverse()).map((m) => m.id);
    const b = normalize(raw).map((m) => m.id);
    expect(a).toEqual(b);
  });
});
