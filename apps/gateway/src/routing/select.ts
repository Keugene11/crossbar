import type { Endpoint } from "../registry/catalog.js";
import type { ProviderPreferences } from "../schemas/routing.js";
import type { StatsTracker } from "./stats.js";

export interface SelectionContext {
  stats: StatsTracker;
  /** Injected so ordering is reproducible in tests. */
  random: () => number;
}

/**
 * Blended price used for weighting, in micro-USD per MTok.
 *
 * Prompt and completion are summed rather than modelled with an assumed
 * output ratio -- guessing a ratio would bias routing for workloads that do not
 * match it, and the sum preserves the relative ordering that matters here.
 */
export function blendedPrice(e: Endpoint): number {
  return e.pricePromptMicro + e.priceCompletionMicro;
}

/** Endpoints failing an explicit constraint are removed outright. */
export function filterEndpoints(
  endpoints: Endpoint[],
  prefs: ProviderPreferences,
): Endpoint[] {
  let out = endpoints;

  if (prefs.only?.length) {
    const allow = new Set(prefs.only);
    out = out.filter((e) => allow.has(e.provider));
  }
  if (prefs.ignore?.length) {
    const deny = new Set(prefs.ignore);
    out = out.filter((e) => !deny.has(e.provider));
  }
  if (prefs.max_price) {
    const { prompt, completion } = prefs.max_price;
    out = out.filter(
      (e) =>
        (prompt === undefined || e.pricePromptMicro <= prompt * 1_000_000) &&
        (completion === undefined || e.priceCompletionMicro <= completion * 1_000_000),
    );
  }
  return out;
}

/**
 * Weighted sampling without replacement, weight proportional to `1 / price^2`.
 *
 * The inverse square is what makes cheap endpoints dominate rather than merely
 * lead: at $1 vs $3 per MTok the cheaper one is ~9x more likely to be tried
 * first. Sampling the whole list (rather than just picking a head) produces the
 * fallback order in the same pass.
 */
export function priceWeightedOrder(endpoints: Endpoint[], random: () => number): Endpoint[] {
  const pool = endpoints.map((e) => ({
    endpoint: e,
    // A free endpoint would divide by zero; floor the price at one micro-USD.
    weight: 1 / Math.max(blendedPrice(e), 1) ** 2,
  }));
  const out: Endpoint[] = [];

  while (pool.length > 0) {
    const total = pool.reduce((sum, p) => sum + p.weight, 0);
    let target = random() * total;
    let picked = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      target -= pool[i]!.weight;
      if (target <= 0) {
        picked = i;
        break;
      }
    }
    out.push(pool[picked]!.endpoint);
    pool.splice(picked, 1);
  }
  return out;
}

function deterministicSort(endpoints: Endpoint[], prefs: ProviderPreferences, ctx: SelectionContext): Endpoint[] {
  const sorted = [...endpoints];
  switch (prefs.sort) {
    case "price":
      sorted.sort((a, b) => blendedPrice(a) - blendedPrice(b) || b.priority - a.priority);
      break;
    case "latency":
      sorted.sort((a, b) => {
        // Unmeasured endpoints sort last rather than pretending to be instant.
        const av = ctx.stats.get(a.id).ttftMsP50 ?? Number.POSITIVE_INFINITY;
        const bv = ctx.stats.get(b.id).ttftMsP50 ?? Number.POSITIVE_INFINITY;
        return av - bv || b.priority - a.priority;
      });
      break;
    case "throughput":
      sorted.sort((a, b) => {
        const av = ctx.stats.get(a.id).throughputP50 ?? -1;
        const bv = ctx.stats.get(b.id).throughputP50 ?? -1;
        return bv - av || b.priority - a.priority;
      });
      break;
  }
  return sorted;
}

/**
 * Produce the full attempt order for one model.
 *
 * Default policy, matching OpenRouter's documented behaviour:
 *   1. endpoints with a failure in the last 30s are deprioritised, not dropped
 *   2. the rest are ordered by inverse-square price weighting
 *   3. whatever remains becomes the fallback chain, in that order
 *
 * An explicit `order` or `sort` replaces steps 1-2 with a deterministic order.
 */
export function orderEndpoints(
  endpoints: Endpoint[],
  prefs: ProviderPreferences,
  ctx: SelectionContext,
): Endpoint[] {
  const filtered = filterEndpoints(endpoints, prefs);
  if (filtered.length <= 1) return filtered;

  if (prefs.order?.length) {
    const rank = new Map(prefs.order.map((p, i) => [p, i]));
    const named = filtered
      .filter((e) => rank.has(e.provider))
      .sort((a, b) => rank.get(a.provider)! - rank.get(b.provider)!);
    // An explicit order is a preference, not an allowlist -- `only` is the
    // allowlist. Unnamed providers stay on as fallbacks behind the named ones.
    const rest = filtered.filter((e) => !rank.has(e.provider));
    return [...named, ...rest];
  }

  if (prefs.sort) return deterministicSort(filtered, prefs, ctx);

  const healthy: Endpoint[] = [];
  const degraded: Endpoint[] = [];
  for (const e of filtered) {
    (ctx.stats.get(e.id).recentOutage ? degraded : healthy).push(e);
  }
  return [
    ...priceWeightedOrder(healthy, ctx.random),
    ...priceWeightedOrder(degraded, ctx.random),
  ];
}
