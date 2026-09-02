import { z } from "zod";

/** Sort strategies. Omitted => price-weighted stochastic ordering (the default). */
export const SortStrategy = z.enum(["price", "throughput", "latency"]);
export type SortStrategy = z.infer<typeof SortStrategy>;

/**
 * Per-request routing preferences. Mirrors OpenRouter's `provider` block so
 * existing client code carries over unchanged.
 */
export const ProviderPreferences = z
  .object({
    /** Try these providers first, in this exact order. */
    order: z.array(z.string()).optional(),
    sort: SortStrategy.optional(),
    /** When false, only the single selected endpoint is attempted. */
    allow_fallbacks: z.boolean().default(true),
    /** Allowlist. When present, every other provider is excluded. */
    only: z.array(z.string()).optional(),
    ignore: z.array(z.string()).optional(),
    /** Ceilings in USD per million tokens. */
    max_price: z
      .object({ prompt: z.number().nonnegative().optional(), completion: z.number().nonnegative().optional() })
      .optional(),
    /** Drop endpoints that cannot honour every parameter in the request. */
    require_parameters: z.boolean().default(false),
    /**
     * "deny" routes only to endpoints that do not retain or train on prompts.
     * The default is "allow", meaning the caller expresses no preference.
     */
    data_collection: z.enum(["allow", "deny"]).default("allow"),
    /**
     * Restrict to endpoints serving these weight quantizations. A heavily
     * quantized variant can underperform the same model served elsewhere.
     */
    quantizations: z.array(z.string().max(32)).max(16).optional(),
  })
  .strict();

export type ProviderPreferences = z.infer<typeof ProviderPreferences>;

export const defaultProviderPreferences: ProviderPreferences = {
  allow_fallbacks: true,
  require_parameters: false,
  data_collection: "allow",
};
