import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicStreamMapper } from "../../src/providers/anthropic/stream.js";
import { mapStopReason, mapUsage, splitContent } from "../../src/providers/anthropic/from-upstream.js";
import type { ChatCompletionChunk } from "../../src/schemas/openai.js";

type Event = Anthropic.Messages.RawMessageStreamEvent;

function run(events: Event[]): ChatCompletionChunk[] {
  const mapper = new AnthropicStreamMapper("test/model", "anthropic");
  return events.flatMap((e) => mapper.map(e));
}

const messageStart = (): Event =>
  ({
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 4 },
    },
  }) as unknown as Event;

const textDelta = (index: number, text: string): Event =>
  ({ type: "content_block_delta", index, delta: { type: "text_delta", text } }) as unknown as Event;

describe("stream event mapping", () => {
  it("opens with an assistant role chunk", () => {
    const [first] = run([messageStart()]);
    expect(first?.choices[0]?.delta).toEqual({ role: "assistant", content: "" });
  });

  it("maps text_delta to delta.content", () => {
    const chunks = run([messageStart(), textDelta(0, "Hel"), textDelta(0, "lo")]);
    expect(chunks.map((c) => c.choices[0]?.delta.content).join("")).toBe("Hello");
  });

  it("maps thinking_delta to delta.reasoning_content, not content", () => {
    const chunks = run([
      messageStart(),
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } } as unknown as Event,
    ]);
    const delta = chunks[1]?.choices[0]?.delta;
    expect(delta?.reasoning_content).toBe("hm");
    expect(delta?.content).toBeUndefined();
  });

  it("drops signature_delta, which has no OpenAI counterpart", () => {
    const chunks = run([
      messageStart(),
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } } as unknown as Event,
    ]);
    expect(chunks).toHaveLength(1);
  });
});

describe("tool call index remapping", () => {
  it("renumbers tool_use blocks into their own zero-based index space", () => {
    // Anthropic block 0 is text and block 1 is the tool call; OpenAI clients
    // assemble arguments by tool_calls index, so this MUST come back as 0.
    const chunks = run([
      messageStart(),
      textDelta(0, "Looking that up."),
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      } as unknown as Event,
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' },
      } as unknown as Event,
    ]);

    const toolChunks = chunks.filter((c) => c.choices[0]?.delta.tool_calls);
    expect(toolChunks[0]?.choices[0]?.delta.tool_calls?.[0]).toEqual({
      index: 0,
      id: "toolu_1",
      type: "function",
      function: { name: "get_weather", arguments: "" },
    });
    expect(toolChunks[1]?.choices[0]?.delta.tool_calls?.[0]).toEqual({
      index: 0,
      function: { arguments: '{"city":"Paris"}' },
    });
  });

  it("numbers a second tool call 1, regardless of its block index", () => {
    const chunks = run([
      messageStart(),
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "a", name: "x", input: {} } } as unknown as Event,
      { type: "content_block_start", index: 5, content_block: { type: "tool_use", id: "b", name: "y", input: {} } } as unknown as Event,
      { type: "content_block_delta", index: 5, delta: { type: "input_json_delta", partial_json: "{}" } } as unknown as Event,
    ]);
    const indices = chunks
      .flatMap((c) => c.choices[0]?.delta.tool_calls ?? [])
      .map((t) => t.index);
    expect(indices).toEqual([0, 1, 1]);
  });

  it("ignores input_json_delta for a block that never opened", () => {
    const chunks = run([
      messageStart(),
      { type: "content_block_delta", index: 7, delta: { type: "input_json_delta", partial_json: "{}" } } as unknown as Event,
    ]);
    expect(chunks).toHaveLength(1);
  });
});

describe("finish reason and usage", () => {
  it("maps stop reasons", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("tool_use")).toBe("tool_calls");
    expect(mapStopReason("refusal")).toBe("content_filter");
    expect(mapStopReason(null)).toBeNull();
  });

  it("downgrades tool_use to stop when no tool call was actually emitted", () => {
    const mapper = new AnthropicStreamMapper("test/model", "anthropic");
    mapper.map(messageStart());
    mapper.map({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } } as unknown as Event);
    expect(mapper.finishReason).toBe("stop");
  });

  it("counts cache reads inside prompt_tokens and reports them separately", () => {
    const mapper = new AnthropicStreamMapper("test/model", "anthropic");
    mapper.map(messageStart());
    mapper.map({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } } as unknown as Event);

    expect(mapper.usage.prompt_tokens).toBe(14); // 10 input + 4 cache read
    expect(mapper.usage.prompt_tokens_details?.cached_tokens).toBe(4);
    expect(mapper.usage.completion_tokens).toBe(6);
    expect(mapper.usage.total_tokens).toBe(20);
  });

  it("mapUsage folds cache creation into the prompt total too", () => {
    const usage = mapUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    } as unknown as Anthropic.Messages.Usage);
    expect(usage.prompt_tokens).toBe(15);
    expect(usage.prompt_tokens_details?.cached_tokens).toBe(3);
  });
});

describe("non-streaming content split", () => {
  it("separates text, thinking, and tool_use blocks", () => {
    const { text, reasoning, toolCalls } = splitContent([
      { type: "thinking", thinking: "considering", signature: "s" },
      { type: "text", text: "Here you go." },
      { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
    ] as unknown as Anthropic.Messages.ContentBlock[]);

    expect(text).toBe("Here you go.");
    expect(reasoning).toBe("considering");
    expect(toolCalls).toEqual([
      { id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
    ]);
  });
});
