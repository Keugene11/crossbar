import type { Catalog, Endpoint } from "../registry/catalog.js";
import type { ChatCompletionRequest } from "../schemas/openai.js";
import { estimatePromptTokens } from "./tokens.js";

/**
 * The auto router: `crossbar/auto` picks a model instead of naming one.
 *
 * OpenRouter ranks candidates by community spend over a trailing window. There
 * is no community here, so ranking is derived from the request itself: what the
 * prompt needs, capped by what the caller is willing to pay. That is a weaker
 * signal than usage data but an honest one, and it degrades predictably --
 * the worst case is a model that is merely more capable than necessary.
 */

export const AUTO_MODEL_ID = "crossbar/auto";

export type CostTier = "low" | "medium" | "high" | "max";

/** Ceilings in micro-USD per MTok (prompt + completion), by tier. */
const TIER_CEILING: Record<CostTier, number> = {
  low: 3_000_000,
  medium: 15_000_000,
  high: 40_000_000,
  max: Number.POSITIVE_INFINITY,
};

export interface AutoContext {
  request: ChatCompletionRequest;
  costTier: CostTier;
  /** Glob-ish allowlist, e.g. ["anthropic/*"]. Empty means no restriction. */
  allowedModels: readonly string[];
}

function matchesAllowed(modelId: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) =>
    p.endsWith("*") ? modelId.startsWith(p.slice(0, -1)) : modelId === p,
  );
}

function blended(e: Endpoint): number {
  return e.pricePromptMicro + e.priceCompletionMicro;
}

/**
 * Score a model for this request. Higher is better; negative means unusable.
 *
 * The shape of the request is the whole signal: a request carrying tools needs
 * an endpoint that supports them, a long prompt needs a window that holds it,
 * and beyond those hard requirements the cheapest capable option wins.
 */
function score(
  endpoints: Endpoint[],
  ctx: AutoContext,
  promptTokens: number,
): { endpoint: Endpoint; score: number } | undefined {
  const needsTools = Boolean(ctx.request.tools?.length);
  const needsReasoning = Boolean(ctx.request.reasoning_effort);
  const needsVision = ctx.request.messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((p) => (p as { type?: string }).type === "image_url"),
  );
  const ceiling = TIER_CEILING[ctx.costTier];

  let best: { endpoint: Endpoint; score: number } | undefined;

  for (const e of endpoints) {
    if (needsTools && !e.supportsTools) continue;
    if (needsVision && !e.supportsVision) continue;
    if (needsReasoning && !e.supportsReasoning) continue;
    if (promptTokens * 1.05 >= e.contextLength) continue;
    if (blended(e) > ceiling) continue;

    // Among everything that qualifies, cheapest wins. Capability is a gate,
    // not a gradient -- paying more for headroom the request never uses is
    // exactly the waste the auto router should avoid.
    const s = -blended(e);
    if (!best || s > best.score) best = { endpoint: e, score: s };
  }
  return best;
}

/**
 * Resolve `crossbar/auto` to a concrete model id.
 *
 * Returns undefined when nothing in the catalog can serve the request, so the
 * caller can raise the same error it would for an unroutable named model.
 */
export function resolveAuto(catalog: Catalog, ctx: AutoContext): string | undefined {
  const promptTokens = estimatePromptTokens(ctx.request);

  let winner: { modelId: string; score: number } | undefined;

  for (const model of catalog.listModels()) {
    if (model.id === AUTO_MODEL_ID) continue;
    if (!matchesAllowed(model.id, ctx.allowedModels)) continue;

    const best = score(catalog.endpointsFor(model.id), ctx, promptTokens);
    if (!best) continue;

    // Ties break on model id so the choice is reproducible run to run.
    if (
      !winner ||
      best.score > winner.score ||
      (best.score === winner.score && model.id < winner.modelId)
    ) {
      winner = { modelId: model.id, score: best.score };
    }
  }

  return winner?.modelId;
}
