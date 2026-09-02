import { describe, expect, it } from "vitest";
import { applyTransforms, middleOut } from "../../src/routing/transforms.js";
import { estimatePromptTokens } from "../../src/routing/tokens.js";
import { ChatCompletionRequest as RequestSchema } from "../../src/schemas/openai.js";
import type { ChatCompletionRequest, Message } from "../../src/schemas/openai.js";

/** ~250 tokens per message at 4 chars/token. */
const filler = (label: string) => `${label} ${"x".repeat(1000)}`;

function conversation(turns: number): Message[] {
  const messages: Message[] = [{ role: "system", content: "You are terse." }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: filler(`u${i}`) });
    messages.push({ role: "assistant", content: filler(`a${i}`) });
  }
  messages.push({ role: "user", content: "the actual question" });
  return messages;
}

const req = (body: Partial<ChatCompletionRequest>): ChatCompletionRequest =>
  RequestSchema.parse({ model: "a/b", messages: [{ role: "user", content: "hi" }], ...body });

describe("middle-out", () => {
  it("leaves a request that already fits completely alone", () => {
    const r = req({ messages: conversation(2) });
    const out = middleOut(r, 1_000_000, 100);
    expect(out.dropped).toBe(0);
    expect(out.messages).toEqual(r.messages);
  });

  it("drops enough to fit, and reports how many", () => {
    const r = req({ messages: conversation(20) });
    const before = estimatePromptTokens(r);
    const out = middleOut(r, 3_000, 200);

    expect(out.dropped).toBeGreaterThan(0);
    expect(out.messages.length).toBeLessThan(r.messages.length);

    const after = estimatePromptTokens({ ...r, messages: out.messages });
    expect(after).toBeLessThan(before);
    expect(after + 200).toBeLessThanOrEqual(3_000);
  });

  it("always keeps every system message and the final turn", () => {
    // These are the two things the model cannot answer without: its
    // instructions, and the question actually being asked.
    const r = req({ messages: conversation(30) });
    const out = middleOut(r, 2_000, 100);

    expect(out.messages[0]).toEqual({ role: "system", content: "You are terse." });
    expect(out.messages.at(-1)).toEqual({ role: "user", content: "the actual question" });
  });

  it("cuts from the middle, not from the recent end", () => {
    // Recall is strongest at the edges of a window, so the most recent turns
    // are the ones worth keeping.
    const r = req({ messages: conversation(20) });
    const out = middleOut(r, 4_000, 100);

    const kept = out.messages.map((m) =>
      typeof m.content === "string" ? m.content.slice(0, 3) : "",
    );
    // The last real exchange before the question should survive.
    expect(kept).toContain("a19");
  });

  it("never orphans a tool result from its call", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: filler("u0") },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: filler("result") },
      { role: "user", content: filler("u1") },
      { role: "assistant", content: filler("a1") },
      { role: "user", content: "final" },
    ];
    const out = middleOut(req({ messages }), 500, 50);

    const hasToolResult = out.messages.some((m) => m.role === "tool");
    const hasToolCall = out.messages.some((m) => m.role === "assistant" && m.tool_calls?.length);
    // A tool result whose call was dropped is a malformed conversation that
    // most providers reject outright.
    if (hasToolResult) expect(hasToolCall).toBe(true);
  });

  it("returns the pinned remainder when nothing droppable is left", () => {
    const r = req({
      messages: [
        { role: "system", content: filler("sys") },
        { role: "user", content: filler("final") },
      ],
    });
    const out = middleOut(r, 10, 5);
    // Both are pinned, so neither can go; the 413 path decides from here.
    expect(out.messages).toHaveLength(2);
  });
});

describe("opt-in behaviour", () => {
  it("does nothing unless the caller asked for it", () => {
    // Silently discarding context is not a safe default: the dropped turns are
    // invisible in the response and the model answers confidently without them.
    const r = req({ messages: conversation(30) });
    expect(applyTransforms(r, 1_000, 100).dropped).toBe(0);
    expect(applyTransforms(r, 1_000, 100).request.messages).toEqual(r.messages);
  });

  it("compresses when middle-out is requested", () => {
    const r = req({ messages: conversation(30), transforms: ["middle-out"] });
    const out = applyTransforms(r, 3_000, 100);
    expect(out.dropped).toBeGreaterThan(0);
    expect(out.request.messages.length).toBeLessThan(r.messages.length);
  });
});
