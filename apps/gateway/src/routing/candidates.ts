import { CrossbarError } from "../errors.js";
import type { Catalog, Endpoint } from "../registry/catalog.js";
import { defaultProviderPreferences, type ProviderPreferences } from "../schemas/routing.js";
import { orderEndpoints, type SelectionContext } from "./select.js";
import { supportsAll } from "./variants.js";

/**
 * Ceiling on endpoints attempted for one request.
 *
 * `models` is already capped, but each model can carry many endpoints, so the
 * product still needs a bound -- otherwise one request can fan out into an
 * unbounded number of upstream calls.
 */
export const MAX_ATTEMPTS_PER_REQUEST = 12;

export interface CandidatePlan {
  /** Every endpoint to try, in order. */
  endpoints: Endpoint[];
  /** Models consulted, in order, including fallbacks. */
  modelIds: string[];
}

/**
 * Flatten `model` plus the `models` fallback chain into one attempt order.
 *
 * Two levels of failover compose here: within a model, endpoints are ordered by
 * policy; across models, the chain is strictly the order the client gave.
 */
export function buildCandidates(
  catalog: Catalog,
  requestedModel: string,
  fallbackModels: string[] | undefined,
  prefs: ProviderPreferences = defaultProviderPreferences,
  ctx: SelectionContext,
  /** Capabilities the request depends on; enforced when require_parameters is set. */
  required: readonly string[] = [],
): CandidatePlan {
  const modelIds = [requestedModel, ...(fallbackModels ?? [])];
  const seen = new Set<string>();
  const endpoints: Endpoint[] = [];

  // The primary model must exist; a typo in a fallback is not worth a 404 when
  // the primary can still serve the request.
  const primary = catalog.requireEndpointsFor(requestedModel);

  for (const [i, modelId] of modelIds.entries()) {
    const available = i === 0 ? primary : catalog.endpointsFor(modelId);
    if (available.length === 0) continue;

    for (const e of orderEndpoints(available, prefs, ctx)) {
      if (seen.has(e.id)) continue;
      // An endpoint that would silently drop `tools` can still answer -- in
      // prose, ignoring the question actually asked. require_parameters lets a
      // caller say they would rather fail than get that.
      if (prefs.require_parameters && !supportsAll(e, required)) continue;
      seen.add(e.id);
      endpoints.push(e);
    }
  }

  if (endpoints.length === 0) {
    throw new CrossbarError({
      status: 502,
      code: "no_endpoints",
      message: prefs.require_parameters && required.length
        ? `No endpoint for "${requestedModel}" supports every required parameter (${required.join(", ")})`
        : `No endpoint satisfies the routing constraints for "${requestedModel}"`,
      retryable: false,
    });
  }

  // `allow_fallbacks: false` means "this endpoint or nothing" -- the client is
  // opting out of the whole point of the gateway, deliberately.
  return {
    endpoints: prefs.allow_fallbacks ? endpoints.slice(0, MAX_ATTEMPTS_PER_REQUEST) : endpoints.slice(0, 1),
    modelIds,
  };
}
