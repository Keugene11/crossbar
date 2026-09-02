/**
 * Providers that speak the OpenAI dialect.
 *
 * Each of these needs no adapter code -- only a base URL and the environment
 * variable holding its key. `OpenAIAdapter` is registered once per entry.
 *
 * OpenRouter is in the list deliberately: it is a provider like any other from
 * crossbar's point of view, and having it as a fallback means every model in
 * the catalog stays reachable even when nothing else is configured.
 */
export interface CompatibleProvider {
  id: string;
  name: string;
  baseUrl: string;
  /** Environment variable holding this provider's key. */
  envVar: string;
  /** Whether prompts sent here may be retained or trained on. */
  mayTrainOnData?: boolean;
  privacyPolicyUrl?: string;
}

export const COMPATIBLE_PROVIDERS: CompatibleProvider[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    envVar: "OPENROUTER_API_KEY",
    privacyPolicyUrl: "https://openrouter.ai/privacy",
  },
  {
    id: "google",
    name: "Google AI Studio",
    // Google publishes an OpenAI-compatible surface alongside its own API.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envVar: "GOOGLE_API_KEY",
    privacyPolicyUrl: "https://ai.google.dev/gemini-api/terms",
  },
  {
    id: "moonshot",
    name: "Moonshot AI",
    baseUrl: "https://api.moonshot.ai/v1",
    envVar: "MOONSHOT_API_KEY",
  },
  {
    id: "zai",
    name: "Z.ai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    envVar: "ZAI_API_KEY",
  },
  {
    id: "dashscope",
    name: "Alibaba Cloud (DashScope)",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    envVar: "DASHSCOPE_API_KEY",
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    envVar: "GROQ_API_KEY",
    privacyPolicyUrl: "https://groq.com/privacy-policy/",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    envVar: "DEEPSEEK_API_KEY",
  },
  {
    id: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    envVar: "XAI_API_KEY",
  },
  {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    envVar: "MISTRAL_API_KEY",
  },
  {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    envVar: "TOGETHER_API_KEY",
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    envVar: "FIREWORKS_API_KEY",
  },
];

/**
 * Which provider natively serves a given model author.
 *
 * Without this, importing a catalog means every model routes through the
 * aggregator it was imported from -- which is a proxy, not a router. Mapping an
 * author to its first-party API gives the request a direct path, and the
 * aggregator becomes what it should be: the fallback behind it.
 *
 * Open-weight families (Llama, and Qwen when self-hosted) are deliberately
 * absent. Nobody serves them "natively" -- you choose a host -- and guessing
 * one host's model ids would be inventing data.
 */
export const NATIVE_PROVIDER_BY_AUTHOR: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  deepseek: "deepseek",
  mistralai: "mistral",
  "x-ai": "xai",
  moonshotai: "moonshot",
  "z-ai": "zai",
  qwen: "dashscope",
};

/**
 * The id that provider knows the model by.
 *
 * Every one of these APIs names its own models without the author prefix that
 * an aggregator adds for disambiguation. When a guess is wrong the upstream
 * answers 404, which the cascade treats as "try the next endpoint" -- so a bad
 * mapping degrades to the aggregator rather than failing the request.
 */
export function nativeModelId(aggregatorId: string): string {
  const slash = aggregatorId.indexOf("/");
  return slash === -1 ? aggregatorId : aggregatorId.slice(slash + 1);
}
