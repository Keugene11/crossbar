import type { ChatCompletionRequest, Message } from "../schemas/openai.js";
import { estimatePromptTokens, fitsContext } from "./tokens.js";

/**
 * Prompt transforms, applied when a request would otherwise not fit.
 *
 * Only `middle-out` exists, matching OpenRouter. It is opt-in: silently
 * discarding a caller's context is not something to do by default, because the
 * dropped turns are invisible in the response and the model will answer
 * confidently without them.
 */
export type Transform = "middle-out";

export interface MiddleOutResult {
  messages: Message[];
  /** How many messages were dropped. Zero means the request was left alone. */
  dropped: number;
}

/**
 * Drop messages from the middle of the conversation until it fits.
 *
 * The middle is the right place to cut: LLM recall is strongest at the start
 * and end of a context window, so the system prompt and the most recent turns
 * carry the most weight. Dropping from the middle preserves both.
 *
 * Two invariants hold no matter how tight the budget gets:
 *   - every system/developer message survives, since they are instructions
 *     rather than history
 *   - the final message survives, since it is what the model is answering
 *
 * Assistant/tool pairs are cut together: a `tool` result whose matching
 * `tool_use` was dropped is a malformed conversation that most providers
 * reject outright.
 */
export function middleOut(
  request: ChatCompletionRequest,
  contextLength: number,
  maxOutputTokens: number,
): MiddleOutResult {
  const messages = request.messages;

  const fits = (candidate: Message[]): boolean =>
    fitsContext(
      estimatePromptTokens({ ...request, messages: candidate }),
      maxOutputTokens,
      contextLength,
    );

  if (fits(messages)) return { messages, dropped: 0 };

  // Indices that must never be dropped.
  const pinned = new Set<number>();
  messages.forEach((m, i) => {
    if (m.role === "system" || m.role === "developer") pinned.add(i);
  });
  pinned.add(messages.length - 1);

  const droppable: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!pinned.has(i)) droppable.push(i);
  }

  // Walk outward from the centre, removing one message at a time.
  const centre = droppable.length / 2;
  const order = [...droppable].sort(
    (a, b) => Math.abs(droppable.indexOf(a) - centre) - Math.abs(droppable.indexOf(b) - centre),
  );

  const removed = new Set<number>();
  for (const index of order) {
    removed.add(index);

    // A tool result without its originating call is malformed; take the pair.
    const next = messages[index + 1];
    if (next?.role === "tool" && !pinned.has(index + 1)) removed.add(index + 1);

    const candidate = messages.filter((_, i) => !removed.has(i));
    if (fits(candidate)) return { messages: candidate, dropped: removed.size };
  }

  // Nothing droppable is left. Returning the pinned remainder lets the caller
  // decide -- it may still be too large, and the 413 path will say so.
  const remainder = messages.filter((_, i) => !removed.has(i));
  return { messages: remainder, dropped: removed.size };
}

/** Apply the requested transforms, returning the request unchanged if none fit. */
export function applyTransforms(
  request: ChatCompletionRequest,
  contextLength: number,
  maxOutputTokens: number,
): { request: ChatCompletionRequest; dropped: number } {
  if (!request.transforms?.includes("middle-out")) return { request, dropped: 0 };

  const result = middleOut(request, contextLength, maxOutputTokens);
  if (result.dropped === 0) return { request, dropped: 0 };

  return { request: { ...request, messages: result.messages }, dropped: result.dropped };
}
