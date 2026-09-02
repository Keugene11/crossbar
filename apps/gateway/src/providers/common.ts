import { randomUUID } from "node:crypto";
import type { Endpoint } from "../registry/catalog.js";
import type { ChatCompletionRequest, ToolChoice } from "../schemas/openai.js";

export function generationId(): string {
  return `gen_${randomUUID().replace(/-/g, "")}`;
}

export function completionId(): string {
  return `chatcmpl_${randomUUID().replace(/-/g, "")}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * `unsupportedParams` entries are either a plain field name (`temperature`) or
 * a field-with-variant (`tool_choice:required`), so an endpoint can reject one
 * shape of a parameter while accepting another.
 */
export function isUnsupported(endpoint: Endpoint, field: string, variant?: string): boolean {
  const list = endpoint.unsupportedParams;
  if (list.includes(field)) return true;
  return variant !== undefined && list.includes(`${field}:${variant}`);
}

export function toolChoiceVariant(choice: ToolChoice): string {
  return typeof choice === "string" ? choice : "function";
}

/**
 * The output ceiling to send upstream.
 *
 * Anthropic requires `max_tokens`; OpenAI does not. Defaults follow the API
 * guidance: a smaller ceiling for buffered responses so they stay inside HTTP
 * timeouts, a larger one when streaming removes that constraint.
 */
export function resolveMaxTokens(request: ChatCompletionRequest, endpoint: Endpoint): number {
  const asked = request.max_completion_tokens ?? request.max_tokens;
  const fallback = request.stream ? 64_000 : 16_000;
  return Math.min(asked ?? fallback, endpoint.maxOutputTokens);
}

export function normalizeStop(stop: string | string[] | undefined): string[] | undefined {
  if (stop === undefined) return undefined;
  const list = typeof stop === "string" ? [stop] : stop;
  return list.length ? list : undefined;
}

/** Flattens the `string | ContentPart[]` union down to plain text. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => !!p && (p as { type?: string }).type === "text")
    .map((p) => p.text)
    .join("");
}
