import { describe, expect, it } from "vitest";
import type { ChatCompletionRequest } from "../../src/schemas/openai.js";
import { ChatCompletionRequest as RequestSchema } from "../../src/schemas/openai.js";
import { defaultProviderPreferences } from "../../src/schemas/routing.js";
import {
  applyVariant,
  parseModelRef,
  requiredCapabilities,
  supportsAll,
} from "../../src/routing/variants.js";
import { makeEndpoint as endpoint } from "../fixtures.js";

const req = (body: Partial<ChatCompletionRequest>): ChatCompletionRequest =>
  RequestSchema.parse({ model: "a/b", messages: [{ role: "user", content: "hi" }], ...body });

describe("model variant suffixes", () => {
  it("splits :nitro and :floor off the catalog id", () => {
    expect(parseModelRef("anthropic/claude-opus-5:nitro")).toEqual({
      id: "anthropic/claude-opus-5",
      variant: "nitro",
    });
    expect(parseModelRef("anthropic/claude-opus-5:floor")).toEqual({
      id: "anthropic/claude-opus-5",
      variant: "floor",
    });
  });

  it("leaves an unknown suffix attached rather than inventing a different model", () => {
    // Truncating here would silently route to a model the caller never named.
    expect(parseModelRef("vendor/model:v2")).toEqual({ id: "vendor/model:v2", variant: undefined });
    expect(parseModelRef("anthropic/claude-opus-5")).toEqual({
      id: "anthropic/claude-opus-5",
      variant: undefined,
    });
    expect(parseModelRef(":nitro")).toEqual({ id: ":nitro", variant: undefined });
  });

  it("maps variants onto the equivalent sort", () => {
    expect(applyVariant(defaultProviderPreferences, "nitro").sort).toBe("throughput");
    expect(applyVariant(defaultProviderPreferences, "floor").sort).toBe("price");
    expect(applyVariant(defaultProviderPreferences, undefined).sort).toBeUndefined();
  });

  it("lets an explicit provider.sort win over the suffix", () => {
    const prefs = { ...defaultProviderPreferences, sort: "latency" as const };
    expect(applyVariant(prefs, "nitro").sort).toBe("latency");
  });
});

describe("require_parameters", () => {
  it("derives the capabilities a request actually depends on", () => {
    expect(requiredCapabilities(req({}))).toEqual([]);
    expect(
      requiredCapabilities(
        req({ tools: [{ type: "function", function: { name: "f" } }], stream: true }),
      ),
    ).toEqual(["tools", "streaming"]);
    expect(requiredCapabilities(req({ temperature: 0.5 }))).toEqual(["temperature"]);
    expect(requiredCapabilities(req({ reasoning_effort: "high" }))).toEqual(["reasoning"]);
  });

  it("rejects an endpoint that would silently drop a required parameter", () => {
    // The failure this prevents: tools dropped, model answers in prose, and the
    // caller gets a confident response to a question they never asked.
    expect(supportsAll(endpoint({ supportsTools: false }), ["tools"])).toBe(false);
    expect(supportsAll(endpoint(), ["tools"])).toBe(true);

    const noSampling = endpoint({ unsupportedParams: ["temperature", "top_p"] });
    expect(supportsAll(noSampling, ["temperature"])).toBe(false);
    expect(supportsAll(noSampling, ["top_k"])).toBe(true);

    expect(supportsAll(endpoint({ supportsReasoning: false }), ["reasoning"])).toBe(false);
    expect(supportsAll(endpoint({ supportsStreaming: false }), ["streaming"])).toBe(false);
  });
});
