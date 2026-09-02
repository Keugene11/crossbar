import type { Endpoint } from "../registry/catalog.js";
import type { ChatCompletionRequest } from "../schemas/openai.js";
import type { ProviderPreferences } from "../schemas/routing.js";

/**
 * OpenRouter-style model variant suffixes.
 *
 * `anthropic/claude-opus-5:nitro` is shorthand for the same model routed for
 * throughput; `:floor` is shorthand for cheapest-first. They are sugar over the
 * `provider.sort` field, so they resolve to exactly that and nothing else.
 */
export const VARIANT_SORTS = {
  nitro: "throughput",
  floor: "price",
} as const;

export type ModelVariant = keyof typeof VARIANT_SORTS;

export interface ModelRef {
  /** The catalog id, with any variant suffix removed. */
  id: string;
  variant: ModelVariant | undefined;
}

/**
 * Split a model reference into its catalog id and variant.
 *
 * Only known variants are stripped -- a model whose slug legitimately contains
 * a colon must not be silently truncated into a different model.
 */
export function parseModelRef(ref: string): ModelRef {
  const cut = ref.lastIndexOf(":");
  if (cut <= 0) return { id: ref, variant: undefined };

  const suffix = ref.slice(cut + 1);
  if (!Object.hasOwn(VARIANT_SORTS, suffix)) return { id: ref, variant: undefined };

  return { id: ref.slice(0, cut), variant: suffix as ModelVariant };
}

/**
 * Fold a variant into routing preferences.
 *
 * An explicit `provider.sort` wins: the client stating a preference outright is
 * more specific than a suffix on the model name.
 */
export function applyVariant(
  prefs: ProviderPreferences,
  variant: ModelVariant | undefined,
): ProviderPreferences {
  if (!variant || prefs.sort) return prefs;
  return { ...prefs, sort: VARIANT_SORTS[variant] };
}

/**
 * Parameters a request actually depends on, for `provider.require_parameters`.
 *
 * Without this the gateway can silently route a tool-calling request to an
 * endpoint that drops the tools and answers in prose -- a correct-looking
 * response to a question the caller never asked.
 */
export function requiredCapabilities(request: ChatCompletionRequest): string[] {
  const needed: string[] = [];
  if (request.tools?.length) needed.push("tools");
  if (request.response_format?.type === "json_schema") needed.push("response_format");
  if (request.reasoning_effort) needed.push("reasoning");
  if (request.temperature !== undefined) needed.push("temperature");
  if (request.top_p !== undefined) needed.push("top_p");
  if (request.top_k !== undefined) needed.push("top_k");
  if (request.stream) needed.push("streaming");
  return needed;
}

/** Whether an endpoint can honour every capability the request depends on. */
export function supportsAll(endpoint: Endpoint, needed: readonly string[]): boolean {
  for (const capability of needed) {
    switch (capability) {
      case "tools":
        if (!endpoint.supportsTools) return false;
        break;
      case "streaming":
        if (!endpoint.supportsStreaming) return false;
        break;
      case "reasoning":
        if (!endpoint.supportsReasoning) return false;
        break;
      default:
        // Anything the endpoint declares it will reject, it cannot honour.
        if (endpoint.unsupportedParams.includes(capability)) return false;
    }
  }
  return true;
}
