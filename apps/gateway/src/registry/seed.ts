/**
 * Catalog seed.
 *
 * Prices are integer micro-USD per million tokens ($5.00/MTok => 5_000_000).
 *
 * Provenance -- both snapshots, re-verify before trusting for billing:
 *   Anthropic: docs.anthropic.com pricing, snapshot 2026-06-24
 *   OpenAI:    developers.openai.com/api/docs/pricing, fetched 2026-09-01
 */

export interface SeedModel {
  id: string;
  name: string;
  description?: string;
  contextLength: number;
  inputModalities: string[];
  outputModalities: string[];
  endpoints: SeedEndpoint[];
}

export interface SeedProvider {
  id: string;
  name: string;
  /** Whether prompts sent to this provider may be retained or trained on. */
  mayTrainOnData: boolean;
  privacyPolicyUrl?: string;
  termsUrl?: string;
  statusPageUrl?: string;
}

/**
 * Provider policies as published for standard API access.
 *
 * Both providers state that API inputs are not used to train their models by
 * default. Consumer and enterprise agreements differ -- verify against your
 * own contract before relying on this for a compliance decision.
 */
export const providerSeed: SeedProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    mayTrainOnData: false,
    privacyPolicyUrl: "https://www.anthropic.com/legal/privacy",
    termsUrl: "https://www.anthropic.com/legal/commercial-terms",
    statusPageUrl: "https://status.anthropic.com",
  },
  {
    id: "openai",
    name: "OpenAI",
    mayTrainOnData: false,
    privacyPolicyUrl: "https://openai.com/policies/privacy-policy",
    termsUrl: "https://openai.com/policies/business-terms",
    statusPageUrl: "https://status.openai.com",
  },
];

export interface SeedEndpoint {
  provider: string;
  upstreamModelId: string;
  /** USD per million tokens; converted to micro-USD on load. */
  pricePrompt: number;
  priceCompletion: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  contextLength?: number;
  maxOutputTokens: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  /** Request fields this endpoint rejects; the adapter strips them. */
  unsupportedParams?: string[];
  /** Weight quantization, when the provider publishes one. */
  quantization?: string;
  /** Whether prompts sent here may be retained or trained on. */
  dataCollection?: "allow" | "deny";
  priority?: number;
}

/**
 * Sampling parameters were removed from Anthropic's current tier -- sending
 * `temperature`/`top_p`/`top_k` to these models is a hard 400, not a warning.
 */
const NO_SAMPLING = ["temperature", "top_p", "top_k"];

/** Fable-tier additionally rejects forced tool choice (`any` / named tool). */
const NO_SAMPLING_NO_FORCED_TOOLS = [...NO_SAMPLING, "tool_choice:required", "tool_choice:function"];

export const catalogSeed: SeedModel[] = [
  {
    // Not a real model: `crossbar/auto` is resolved to a concrete one before
    // routing. It carries no endpoints, and the router skips it explicitly.
    id: "crossbar/auto",
    name: "crossbar: Auto Router",
    description:
      "Picks a model from the catalog based on what the request needs, capped by cost_tier.",
    contextLength: 1_000_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    endpoints: [],
  },
  {
    id: "anthropic/claude-opus-5",
    name: "Anthropic: Claude Opus 5",
    description: "Anthropic's default frontier model. Adaptive thinking on by default.",
    contextLength: 1_000_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    endpoints: [
      {
        provider: "anthropic",
        upstreamModelId: "claude-opus-5",
        pricePrompt: 5,
        priceCompletion: 25,
        priceCacheRead: 0.5,
        priceCacheWrite: 6.25,
        maxOutputTokens: 128_000,
        supportsVision: true,
        supportsReasoning: true,
        unsupportedParams: NO_SAMPLING,
      },
    ],
  },
  {
    id: "anthropic/claude-sonnet-5",
    name: "Anthropic: Claude Sonnet 5",
    contextLength: 1_000_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    endpoints: [
      {
        provider: "anthropic",
        upstreamModelId: "claude-sonnet-5",
        pricePrompt: 2,
        priceCompletion: 10,
        priceCacheRead: 0.2,
        priceCacheWrite: 2.5,
        maxOutputTokens: 128_000,
        supportsVision: true,
        supportsReasoning: true,
        unsupportedParams: NO_SAMPLING,
      },
    ],
  },
  {
    id: "anthropic/claude-opus-4-8",
    name: "Anthropic: Claude Opus 4.8",
    contextLength: 1_000_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    endpoints: [
      {
        provider: "anthropic",
        upstreamModelId: "claude-opus-4-8",
        pricePrompt: 5,
        priceCompletion: 25,
        priceCacheRead: 0.5,
        priceCacheWrite: 6.25,
        maxOutputTokens: 128_000,
        supportsVision: true,
        supportsReasoning: true,
        unsupportedParams: NO_SAMPLING,
      },
    ],
  },
  {
    id: "anthropic/claude-fable-5-1",
    name: "Anthropic: Claude Fable 5.1",
    description: "Thinking is always on; forced tool choice is rejected.",
    contextLength: 1_000_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    endpoints: [
      {
        provider: "anthropic",
        upstreamModelId: "claude-fable-5-1",
        pricePrompt: 10,
        priceCompletion: 50,
        priceCacheRead: 0.25,
        priceCacheWrite: 12.5,
        maxOutputTokens: 128_000,
        supportsVision: true,
        supportsReasoning: true,
        unsupportedParams: NO_SAMPLING_NO_FORCED_TOOLS,
      },
    ],
  },
  {
    id: "anthropic/claude-haiku-4-5",
    name: "Anthropic: Claude Haiku 4.5",
    description: "Small, fast, and cheap. Pre-4.6 generation, so sampling params still apply.",
    contextLength: 200_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    endpoints: [
      {
        provider: "anthropic",
        upstreamModelId: "claude-haiku-4-5",
        pricePrompt: 1,
        priceCompletion: 5,
        priceCacheRead: 0.1,
        priceCacheWrite: 1.25,
        maxOutputTokens: 64_000,
        supportsVision: true,
        supportsReasoning: false,
        unsupportedParams: [],
      },
    ],
  },

  {
    id: "openai/gpt-5.6-sol",
    name: "OpenAI: GPT-5.6 Sol",
    contextLength: 1_050_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    endpoints: [
      {
        provider: "openai",
        upstreamModelId: "gpt-5.6-sol",
        pricePrompt: 4,
        priceCompletion: 20,
        priceCacheRead: 0.4,
        maxOutputTokens: 128_000,
        supportsVision: true,
        supportsReasoning: true,
      },
    ],
  },
  {
    id: "openai/gpt-5.6-terra",
    name: "OpenAI: GPT-5.6 Terra",
    contextLength: 1_050_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    endpoints: [
      {
        provider: "openai",
        upstreamModelId: "gpt-5.6-terra",
        pricePrompt: 2,
        priceCompletion: 12,
        priceCacheRead: 0.2,
        maxOutputTokens: 128_000,
        supportsVision: true,
        supportsReasoning: true,
      },
    ],
  },
  {
    id: "openai/gpt-5.6-luna",
    name: "OpenAI: GPT-5.6 Luna",
    contextLength: 1_050_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    endpoints: [
      {
        provider: "openai",
        upstreamModelId: "gpt-5.6-luna",
        pricePrompt: 0.2,
        priceCompletion: 1.2,
        priceCacheRead: 0.02,
        maxOutputTokens: 128_000,
        supportsVision: true,
        supportsReasoning: true,
      },
    ],
  },
  {
    id: "openai/gpt-5",
    name: "OpenAI: GPT-5",
    contextLength: 400_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    endpoints: [
      {
        provider: "openai",
        upstreamModelId: "gpt-5",
        pricePrompt: 1.25,
        priceCompletion: 10,
        priceCacheRead: 0.125,
        maxOutputTokens: 128_000,
        supportsVision: true,
        supportsReasoning: true,
      },
    ],
  },
  {
    id: "openai/gpt-5-mini",
    name: "OpenAI: GPT-5 Mini",
    contextLength: 400_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    endpoints: [
      {
        provider: "openai",
        upstreamModelId: "gpt-5-mini",
        pricePrompt: 0.25,
        priceCompletion: 2,
        priceCacheRead: 0.025,
        maxOutputTokens: 128_000,
        supportsVision: true,
        supportsReasoning: true,
      },
    ],
  },
  {
    id: "openai/gpt-4o-mini",
    name: "OpenAI: GPT-4o Mini",
    contextLength: 128_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    endpoints: [
      {
        provider: "openai",
        upstreamModelId: "gpt-4o-mini",
        pricePrompt: 0.15,
        priceCompletion: 0.6,
        priceCacheRead: 0.075,
        maxOutputTokens: 16_384,
        supportsVision: true,
      },
    ],
  },
];

/** USD per MTok -> integer micro-USD per MTok. */
export function toMicro(usdPerMTok: number): number {
  return Math.round(usdPerMTok * 1_000_000);
}

export function endpointId(modelId: string, provider: string): string {
  return `${modelId}::${provider}`;
}
