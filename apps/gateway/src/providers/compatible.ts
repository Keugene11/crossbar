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
