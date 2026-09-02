import { describe, expect, it } from "vitest";
import { toMessageCreateParams, convertMessages } from "../../src/providers/anthropic/to-upstream.js";
import type { Endpoint } from "../../src/registry/catalog.js";
import type { ChatCompletionRequest } from "../../src/schemas/openai.js";
import { ChatCompletionRequest as RequestSchema } from "../../src/schemas/openai.js";

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    id: "test/model::anthropic",
    modelId: "test/model",
    provider: "anthropic",
    upstreamModelId: "claude-opus-5",
    baseUrl: null,
    pricePromptMicro: 5_000_000,
    priceCompletionMicro: 25_000_000,
    priceCacheReadMicro: 500_000,
    priceCacheWriteMicro: 6_250_000,
    contextLength: 1_000_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsReasoning: true,
    unsupportedParams: ["temperature", "top_p", "top_k"],
    status: "active",
    priority: 0,
    ...overrides,
  };
}

function request(body: Partial<ChatCompletionRequest>): ChatCompletionRequest {
  return RequestSchema.parse({
    model: "test/model",
    messages: [{ role: "user", content: "hi" }],
    ...body,
  });
}

describe("system prompt hoisting", () => {
  it("moves system and developer messages out of the message list", () => {
    const { system, messages } = convertMessages([
      { role: "system", content: "You are terse." },
      { role: "developer", content: "Never apologise." },
      { role: "user", content: "hi" },
    ]);

    expect(system).toEqual([
      { type: "text", text: "You are terse." },
      { type: "text", text: "Never apologise." },
    ]);
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });
});

describe("tool round-trip", () => {
  it("maps assistant tool_calls to tool_use blocks", () => {
    const { messages } = convertMessages([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
    ]);

    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } }],
    });
  });

  it("merges consecutive tool results into ONE user message", () => {
    // Splitting parallel tool results across messages teaches the model to stop
    // emitting parallel calls, so this collapse is load-bearing, not cosmetic.
    const { messages } = convertMessages([
      { role: "user", content: "weather in both?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "w", arguments: "{}" } },
          { id: "call_2", type: "function", function: { name: "w", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
      { role: "tool", tool_call_id: "call_2", content: "rainy" },
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "sunny" }] },
        { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "rainy" }] },
      ],
    });
  });

  it("rejects malformed tool arguments as a 400 rather than passing them upstream", () => {
    expect(() =>
      convertMessages([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "w", arguments: "{not json" } },
          ],
        },
      ]),
    ).toThrowError(/not valid JSON/);
  });
});

describe("images", () => {
  it("splits a data URI into a base64 source", () => {
    const { messages } = convertMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } },
        ],
      },
    ]);

    expect(messages[0]?.content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } },
    ]);
  });

  it("passes an http URL through as a url source", () => {
    const { messages } = convertMessages([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
      },
    ]);
    expect(messages[0]?.content).toEqual([
      { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
    ]);
  });
});

describe("endpoint quirks", () => {
  it("strips sampling params that the current Anthropic tier rejects", () => {
    const params = toMessageCreateParams(
      request({ temperature: 0.7, top_p: 0.9, top_k: 40 }),
      endpoint(),
    );
    expect(params.temperature).toBeUndefined();
    expect(params.top_p).toBeUndefined();
    expect(params.top_k).toBeUndefined();
  });

  it("keeps sampling params on an endpoint that accepts them", () => {
    const params = toMessageCreateParams(
      request({ temperature: 0.7 }),
      endpoint({ unsupportedParams: [] }),
    );
    expect(params.temperature).toBe(0.7);
  });

  it("drops forced tool choice on endpoints that reject it", () => {
    const fable = endpoint({ unsupportedParams: ["tool_choice:required"] });
    const req = request({
      tools: [{ type: "function", function: { name: "w", parameters: { type: "object" } } }],
      tool_choice: "required",
    });
    expect(toMessageCreateParams(req, fable).tool_choice).toBeUndefined();
    expect(toMessageCreateParams(req, endpoint()).tool_choice).toEqual({ type: "any" });
  });

  it("never emits budget_tokens, and uses adaptive thinking", () => {
    const params = toMessageCreateParams(request({}), endpoint());
    expect(params.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(JSON.stringify(params)).not.toContain("budget_tokens");
  });

  it("omits thinking entirely on a non-reasoning endpoint", () => {
    const params = toMessageCreateParams(request({}), endpoint({ supportsReasoning: false }));
    expect(params.thinking).toBeUndefined();
  });
});

describe("parameter mapping", () => {
  it("maps tool_choice variants", () => {
    const tools: ChatCompletionRequest["tools"] = [
      { type: "function", function: { name: "w", parameters: { type: "object" } } },
    ];
    const map = (choice: ChatCompletionRequest["tool_choice"]) =>
      toMessageCreateParams(request({ tools, tool_choice: choice }), endpoint()).tool_choice;

    expect(map("auto")).toEqual({ type: "auto" });
    expect(map("none")).toEqual({ type: "none" });
    expect(map("required")).toEqual({ type: "any" });
    expect(map({ type: "function", function: { name: "w" } })).toEqual({ type: "tool", name: "w" });
  });

  it("maps response_format json_schema onto output_config.format", () => {
    const params = toMessageCreateParams(
      request({
        response_format: {
          type: "json_schema",
          json_schema: { name: "answer", schema: { type: "object" } },
        },
      }),
      endpoint(),
    );
    expect(params.output_config?.format).toEqual({ type: "json_schema", schema: { type: "object" } });
  });

  it("maps reasoning_effort onto output_config.effort, including xhigh", () => {
    expect(
      toMessageCreateParams(request({ reasoning_effort: "xhigh" }), endpoint()).output_config?.effort,
    ).toBe("xhigh");
    expect(
      toMessageCreateParams(request({ reasoning_effort: "minimal" }), endpoint()).output_config?.effort,
    ).toBe("low");
  });

  it("normalises stop into stop_sequences", () => {
    expect(toMessageCreateParams(request({ stop: "END" }), endpoint()).stop_sequences).toEqual(["END"]);
  });

  it("always sets max_tokens, clamped to the endpoint ceiling", () => {
    expect(toMessageCreateParams(request({}), endpoint()).max_tokens).toBe(16_000);
    expect(toMessageCreateParams(request({ stream: true }), endpoint()).max_tokens).toBe(64_000);
    expect(
      toMessageCreateParams(request({ max_tokens: 999_999 }), endpoint({ maxOutputTokens: 8192 }))
        .max_tokens,
    ).toBe(8192);
  });
});
