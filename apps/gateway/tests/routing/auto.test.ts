import { describe, expect, it } from "vitest";
import { estimatePromptTokens, fitsContext } from "../../src/routing/tokens.js";
import { ChatCompletionRequest as RequestSchema } from "../../src/schemas/openai.js";
import type { ChatCompletionRequest } from "../../src/schemas/openai.js";

const req = (body: Partial<ChatCompletionRequest>): ChatCompletionRequest =>
  RequestSchema.parse({ model: "a/b", messages: [{ role: "user", content: "hi" }], ...body });

describe("prompt sizing", () => {
  it("grows with the prompt", () => {
    const small = estimatePromptTokens(req({ messages: [{ role: "user", content: "hi" }] }));
    const large = estimatePromptTokens(
      req({ messages: [{ role: "user", content: "x".repeat(40_000) }] }),
    );
    expect(large).toBeGreaterThan(small);
    // ~4 chars per token, so 40k chars is on the order of 10k tokens.
    expect(large).toBeGreaterThan(9_000);
    expect(large).toBeLessThan(12_000);
  });

  it("counts tool schemas, which are re-sent every turn", () => {
    const withTools = estimatePromptTokens(
      req({
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Look up the weather somewhere",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      }),
    );
    expect(withTools).toBeGreaterThan(estimatePromptTokens(req({})));
  });

  it("charges images far more than their URL length suggests", () => {
    const withImage = estimatePromptTokens(
      req({
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://e.com/a.png" } }],
          },
        ],
      }),
    );
    expect(withImage).toBeGreaterThan(1_000);
  });
});

describe("context fitting", () => {
  it("rejects a prompt plus output that overflows the window", () => {
    expect(fitsContext(1_000, 500, 10_000)).toBe(true);
    expect(fitsContext(9_000, 2_000, 10_000)).toBe(false);
  });

  it("keeps slack, so a borderline request is not routed somewhere it barely fits", () => {
    // Exactly at the boundary the estimate is not trustworthy in either
    // direction, so it must not count as a fit.
    expect(fitsContext(10_000, 0, 10_000)).toBe(false);
    expect(fitsContext(9_000, 0, 10_000)).toBe(true);
  });
});
