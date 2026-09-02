import type { ErrorEnvelope } from "../errors.js";
import type { ChatCompletionChunk } from "../schemas/openai.js";

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Stops nginx and friends from buffering the stream into uselessness.
  "x-accel-buffering": "no",
} as const;

export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function sseChunk(chunk: ChatCompletionChunk): string {
  return sseData(chunk);
}

/**
 * A comment line. Clients ignore it, but it keeps intermediaries from closing
 * an idle connection while a slow model is still thinking.
 */
export function sseKeepAlive(): string {
  return ": keep-alive\n\n";
}

/**
 * Terminal error inside an already-open stream.
 *
 * The status line was sent long ago, so the only way to tell the client is a
 * final data frame. `[DONE]` still follows, so well-behaved clients terminate
 * cleanly instead of hanging.
 */
export function sseError(envelope: ErrorEnvelope): string {
  return sseData(envelope);
}

export const SSE_DONE = "data: [DONE]\n\n";
