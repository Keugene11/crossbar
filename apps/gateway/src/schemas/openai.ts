import { z } from "zod";
import { ProviderPreferences } from "./routing.js";

/**
 * The OpenAI Chat Completions wire format.
 *
 * This is not just the edge contract -- it is crossbar's internal representation
 * too. Adapters translate into and out of it at the provider boundary and
 * nowhere else, so adding a provider never touches the routing core.
 */

/**
 * Marks a content part as a prompt-cache breakpoint.
 *
 * Passed straight through to providers that support caching. Placement is the
 * caller's decision because it depends on which prefix of *their* prompt is
 * stable, which the gateway has no way to know.
 */
export const CacheControl = z.object({ type: z.literal("ephemeral") });

export const TextPart = z.object({
  type: z.literal("text"),
  text: z.string(),
  cache_control: CacheControl.optional(),
});

export const ImagePart = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(["auto", "low", "high"]).optional(),
  }),
});

export const ContentPart = z.discriminatedUnion("type", [TextPart, ImagePart]);
export type ContentPart = z.infer<typeof ContentPart>;

export const ToolCall = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
export type ToolCall = z.infer<typeof ToolCall>;

const SystemMessage = z.object({
  role: z.enum(["system", "developer"]),
  content: z.union([z.string(), z.array(TextPart)]),
  name: z.string().optional(),
});

const UserMessage = z.object({
  role: z.literal("user"),
  content: z.union([z.string(), z.array(ContentPart)]),
  name: z.string().optional(),
});

const AssistantMessage = z.object({
  role: z.literal("assistant"),
  content: z.union([z.string(), z.array(TextPart), z.null()]).optional(),
  /** Surfaced by crossbar for reasoning models; echoed back but not re-sent upstream. */
  reasoning_content: z.string().nullish(),
  tool_calls: z.array(ToolCall).optional(),
  name: z.string().optional(),
});

const ToolMessage = z.object({
  role: z.literal("tool"),
  content: z.union([z.string(), z.array(TextPart)]),
  tool_call_id: z.string(),
});

export const Message = z.union([SystemMessage, UserMessage, AssistantMessage, ToolMessage]);
export type Message = z.infer<typeof Message>;
export type AssistantMessage = z.infer<typeof AssistantMessage>;

export const ToolDefinition = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().nullish(),
  }),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

export const ToolChoice = z.union([
  z.enum(["none", "auto", "required"]),
  z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) }),
]);
export type ToolChoice = z.infer<typeof ToolChoice>;

export const ResponseFormat = z.union([
  z.object({ type: z.literal("text") }),
  z.object({ type: z.literal("json_object") }),
  z.object({
    type: z.literal("json_schema"),
    json_schema: z.object({
      name: z.string(),
      description: z.string().optional(),
      schema: z.record(z.string(), z.unknown()),
      strict: z.boolean().nullish(),
    }),
  }),
]);
export type ResponseFormat = z.infer<typeof ResponseFormat>;

/**
 * `xhigh` and `max` are beyond OpenAI's vocabulary but map cleanly onto
 * Anthropic's `output_config.effort`; the OpenAI adapter clamps them down.
 */
export const ReasoningEffort = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

/**
 * Caps on repeated fields.
 *
 * These are denial-of-service bounds, not correctness ones: `models` multiplies
 * upstream attempts per request, and the rest multiply parse and translation
 * work. All are far above any legitimate use.
 */
export const LIMITS = {
  messages: 5_000,
  fallbackModels: 8,
  tools: 256,
  stopSequences: 8,
  modelIdLength: 256,
} as const;

export const ChatCompletionRequest = z
  .object({
    model: z.string().min(1).max(LIMITS.modelIdLength),
    messages: z.array(Message).min(1).max(LIMITS.messages),

    stream: z.boolean().default(false),
    stream_options: z.object({ include_usage: z.boolean().default(false) }).optional(),

    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().positive().optional(),
    stop: z.union([z.string(), z.array(z.string()).max(LIMITS.stopSequences)]).optional(),
    seed: z.number().int().optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),

    tools: z.array(ToolDefinition).max(LIMITS.tools).optional(),
    tool_choice: ToolChoice.optional(),
    parallel_tool_calls: z.boolean().optional(),
    response_format: ResponseFormat.optional(),
    reasoning_effort: ReasoningEffort.optional(),

    user: z.string().optional(),

    // ---- crossbar extensions ----
    /** Model-level fallback chain, tried in order after `model` is exhausted. */
    models: z.array(z.string().max(LIMITS.modelIdLength)).max(LIMITS.fallbackModels).optional(),
    provider: ProviderPreferences.optional(),
    /** Force usage accounting into the final streamed chunk. */
    usage: z.object({ include: z.boolean() }).optional(),
    /**
     * Prompt transforms applied when the request would not otherwise fit.
     * Opt-in: dropping a caller's context silently is not a safe default.
     */
    transforms: z.array(z.enum(["middle-out"])).max(4).optional(),
    /** Spend ceiling for `crossbar/auto`. Ignored for a named model. */
    cost_tier: z.enum(["low", "medium", "high", "max"]).optional(),
    /** Restrict `crossbar/auto` to these ids or `author/*` prefixes. */
    allowed_models: z.array(z.string().max(LIMITS.modelIdLength)).max(64).optional(),
  })
  .strict();

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>;

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "error" | null;

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /** crossbar addition: cost of this generation in USD. */
  cost?: number;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  provider?: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      reasoning_content?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: FinishReason;
  }>;
  usage: Usage;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  provider?: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: FinishReason;
  }>;
  usage?: Usage | null;
}
