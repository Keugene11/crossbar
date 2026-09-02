import type Anthropic from "@anthropic-ai/sdk";
import type { ChatCompletionChunk, FinishReason, Usage } from "../../schemas/openai.js";
import { completionId, nowSeconds } from "../common.js";
import { mapStopReason } from "./from-upstream.js";

type StreamEvent = Anthropic.Messages.RawMessageStreamEvent;

/**
 * Translates the Anthropic event stream into OpenAI chunks.
 *
 * Stateful for one reason that matters: Anthropic gives every content block --
 * text, thinking, and tool_use alike -- a position in a single `index` space,
 * while OpenAI numbers `tool_calls` in their own space starting at 0. A
 * response whose first block is text and second is a tool call would otherwise
 * emit `tool_calls[1]` with no `tool_calls[0]`, which breaks every client that
 * assembles arguments by index.
 */
export class AnthropicStreamMapper {
  readonly #id = completionId();
  readonly #created = nowSeconds();
  readonly #model: string;
  readonly #provider: string;

  /** Anthropic block index -> OpenAI tool_calls index. */
  readonly #toolIndexByBlock = new Map<number, number>();
  #nextToolIndex = 0;

  #promptTokens = 0;
  #cachedTokens = 0;
  #cacheWriteTokens = 0;
  #completionTokens = 0;
  #finishReason: FinishReason = null;
  #sawToolUse = false;

  constructor(model: string, provider: string) {
    this.#model = model;
    this.#provider = provider;
  }

  get finishReason(): FinishReason {
    return this.#finishReason;
  }

  get usage(): Usage {
    return {
      prompt_tokens: this.#promptTokens,
      completion_tokens: this.#completionTokens,
      total_tokens: this.#promptTokens + this.#completionTokens,
      prompt_tokens_details: {
        cached_tokens: this.#cachedTokens,
        cache_write_tokens: this.#cacheWriteTokens,
      },
      completion_tokens_details: { reasoning_tokens: 0 },
    };
  }

  #chunk(
    delta: ChatCompletionChunk["choices"][number]["delta"],
    finish: FinishReason = null,
  ): ChatCompletionChunk {
    return {
      id: this.#id,
      object: "chat.completion.chunk",
      created: this.#created,
      model: this.#model,
      provider: this.#provider,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
  }

  /** Zero or more OpenAI chunks for one upstream event. */
  map(event: StreamEvent): ChatCompletionChunk[] {
    switch (event.type) {
      case "message_start": {
        const u = event.message.usage;
        this.#promptTokens =
          (u?.input_tokens ?? 0) +
          (u?.cache_read_input_tokens ?? 0) +
          (u?.cache_creation_input_tokens ?? 0);
        this.#cachedTokens = u?.cache_read_input_tokens ?? 0;
        this.#cacheWriteTokens = u?.cache_creation_input_tokens ?? 0;
        return [this.#chunk({ role: "assistant", content: "" })];
      }

      case "content_block_start": {
        const block = event.content_block;
        if (block.type !== "tool_use") return [];
        this.#sawToolUse = true;
        const toolIndex = this.#nextToolIndex++;
        this.#toolIndexByBlock.set(event.index, toolIndex);
        return [
          this.#chunk({
            tool_calls: [
              {
                index: toolIndex,
                id: block.id,
                type: "function",
                function: { name: block.name, arguments: "" },
              },
            ],
          }),
        ];
      }

      case "content_block_delta": {
        const delta = event.delta;
        switch (delta.type) {
          case "text_delta":
            return [this.#chunk({ content: delta.text })];
          case "thinking_delta":
            return [this.#chunk({ reasoning_content: delta.thinking })];
          case "input_json_delta": {
            const toolIndex = this.#toolIndexByBlock.get(event.index);
            if (toolIndex === undefined) return [];
            return [
              this.#chunk({
                tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }],
              }),
            ];
          }
          default:
            // signature_delta / citations_delta have no OpenAI counterpart.
            return [];
        }
      }

      case "message_delta": {
        const u = event.usage as { output_tokens?: number } | undefined;
        if (typeof u?.output_tokens === "number") this.#completionTokens = u.output_tokens;

        const mapped = mapStopReason(event.delta.stop_reason);
        this.#finishReason =
          mapped === "tool_calls" && !this.#sawToolUse ? "stop" : mapped;
        return [this.#chunk({}, this.#finishReason)];
      }

      default:
        // content_block_stop and message_stop carry nothing a client needs;
        // the route writes the terminating [DONE] itself.
        return [];
    }
  }

  /** Trailing usage-only chunk, emitted when the client asked for accounting. */
  usageChunk(): ChatCompletionChunk {
    return {
      id: this.#id,
      object: "chat.completion.chunk",
      created: this.#created,
      model: this.#model,
      provider: this.#provider,
      choices: [],
      usage: this.usage,
    };
  }
}
