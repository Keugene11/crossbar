import type Anthropic from "@anthropic-ai/sdk";
import type {
  ChatCompletion,
  FinishReason,
  ToolCall,
  Usage,
} from "../../schemas/openai.js";
import { completionId, nowSeconds } from "../common.js";

/**
 * Anthropic stop reasons -> OpenAI finish reasons.
 *
 * `refusal` is a 200-OK outcome on current models, not an exception, so it must
 * be mapped here or it silently becomes a `stop` with empty content.
 */
export function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
    case "pause_turn":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    case null:
    case undefined:
      return null;
    default:
      return "stop";
  }
}

export function mapUsage(usage: Anthropic.Messages.Usage | undefined): Usage {
  const prompt = usage?.input_tokens ?? 0;
  const completion = usage?.output_tokens ?? 0;
  const cached = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  // Cache reads and writes are input tokens the client was charged for at
  // different rates, so they belong inside the prompt total, not alongside it.
  const promptTotal = prompt + cached + cacheWrite;
  return {
    prompt_tokens: promptTotal,
    completion_tokens: completion,
    total_tokens: promptTotal + completion,
    prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: cacheWrite },
    completion_tokens_details: { reasoning_tokens: 0 },
  };
}

/** Split Anthropic content blocks into OpenAI text / reasoning / tool_calls. */
export function splitContent(blocks: Anthropic.Messages.ContentBlock[]): {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
} {
  let text = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        text += block.text;
        break;
      case "thinking":
        reasoning += block.thinking;
        break;
      case "tool_use":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
        break;
      default:
        // Server-tool blocks (web_search, code_execution, ...) have no OpenAI
        // equivalent; they are intentionally dropped rather than mangled.
        break;
    }
  }
  return { text, reasoning, toolCalls };
}

export function toChatCompletion(
  message: Anthropic.Messages.Message,
  modelId: string,
  provider: string,
): ChatCompletion {
  const { text, reasoning, toolCalls } = splitContent(message.content);
  const finish = mapStopReason(message.stop_reason);

  return {
    id: completionId(),
    object: "chat.completion",
    created: nowSeconds(),
    model: modelId,
    provider,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text.length ? text : null,
          ...(reasoning.length ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        // A tool_use stop with no blocks parsed would be a lie; fall back to stop.
        finish_reason: finish === "tool_calls" && toolCalls.length === 0 ? "stop" : finish,
      },
    ],
    usage: mapUsage(message.usage),
  };
}
