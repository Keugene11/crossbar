import type { ChatCompletionRequest } from "../schemas/openai.js";

/**
 * Cheap pre-flight token estimate.
 *
 * Deliberately approximate: this exists to answer "can this endpoint possibly
 * fit the request", not to bill for it. Exact counting would need each
 * provider's tokenizer (and a network round-trip for Anthropic's
 * count_tokens), which is far too much work to do before every routing
 * decision. Billing always uses the counts the provider reports back.
 */

/** Characters per token, averaged across English prose and code. */
const CHARS_PER_TOKEN = 4;

/** Per-message overhead for role and delimiter tokens. */
const MESSAGE_OVERHEAD = 4;

/** An image costs far more than its URL suggests; a mid-size tile is ~1.5k. */
const IMAGE_TOKENS = 1_500;

function textLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;

  let chars = 0;
  for (const part of content) {
    const p = part as { type?: string; text?: string };
    if (p.type === "text" && typeof p.text === "string") chars += p.text.length;
  }
  return chars;
}

function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((p) => (p as { type?: string }).type === "image_url").length;
}

/** Rough input size, in tokens, for the whole request. */
export function estimatePromptTokens(request: ChatCompletionRequest): number {
  let chars = 0;
  let images = 0;
  let overhead = 0;

  for (const m of request.messages) {
    overhead += MESSAGE_OVERHEAD;
    chars += textLength(m.content);
    images += imageCount(m.content);

    if (m.role === "assistant" && m.tool_calls) {
      for (const call of m.tool_calls) {
        chars += call.function.name.length + call.function.arguments.length;
      }
    }
  }

  // Tool schemas are re-sent on every turn and are easy to underestimate.
  for (const tool of request.tools ?? []) {
    chars += tool.function.name.length + (tool.function.description?.length ?? 0);
    chars += JSON.stringify(tool.function.parameters ?? {}).length;
  }

  return Math.ceil(chars / CHARS_PER_TOKEN) + overhead + images * IMAGE_TOKENS;
}

/**
 * Whether an endpoint's context window can hold the prompt plus the requested
 * output.
 *
 * `slack` keeps a borderline request from being routed to an endpoint it only
 * just fits, since the estimate is approximate in both directions.
 */
export function fitsContext(
  promptTokens: number,
  maxOutputTokens: number,
  contextLength: number,
  slack = 0.05,
): boolean {
  return promptTokens * (1 + slack) + maxOutputTokens <= contextLength;
}
