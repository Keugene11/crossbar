import type { Endpoint } from "../registry/catalog.js";
import type { Usage } from "../schemas/openai.js";

/**
 * Cost of one generation in integer micro-USD.
 *
 * Prices are micro-USD per million tokens, so the division by 1e6 happens once,
 * at the end, on the summed product -- rounding each component separately would
 * accumulate error across millions of generations.
 */
export function costMicro(usage: Usage, endpoint: Endpoint): number {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
  // `prompt_tokens` is the full input count; cached reads and cache writes are
  // subsets of it billed at their own rates, not additions to it.
  const uncached = Math.max(usage.prompt_tokens - cached - cacheWrite, 0);
  const readRate = endpoint.priceCacheReadMicro ?? endpoint.pricePromptMicro;
  // Writing to cache costs a premium; without a published rate it is ordinary
  // input, which is the conservative reading.
  const writeRate = endpoint.priceCacheWriteMicro ?? endpoint.pricePromptMicro;

  const total =
    uncached * endpoint.pricePromptMicro +
    cached * readRate +
    cacheWrite * writeRate +
    usage.completion_tokens * endpoint.priceCompletionMicro;

  return Math.round(total / 1_000_000);
}

export function microToUsd(micro: number): number {
  return micro / 1_000_000;
}
