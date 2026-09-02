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
 * How long a stream may go silent before a keep-alive comment is sent.
 *
 * Well under the 30-60s idle timeout typical of load balancers and reverse
 * proxies, which would otherwise drop a connection during a long think.
 */
export const KEEPALIVE_INTERVAL_MS = 15_000;

export const SSE_DONE = "data: [DONE]\n\n";
