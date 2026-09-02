import OpenAI from "openai";
import type { CrossbarError } from "../../errors.js";
import type { Endpoint } from "../../registry/catalog.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
  FinishReason,
  Usage,
} from "../../schemas/openai.js";
import type { AdapterOptions, ProviderAdapter } from "../types.js";
import { classifyProviderError } from "../classify.js";
import { isUnsupported, resolveMaxTokens, toolChoiceVariant } from "../common.js";

/** OpenAI's own effort vocabulary stops at `high`. */
function clampEffort(effort: string | undefined): "minimal" | "low" | "medium" | "high" | undefined {
  switch (effort) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
      return effort;
    case "xhigh":
    case "max":
      return "high";
    default:
      return undefined;
  }
}

/**
 * The reference adapter: OpenAI Chat Completions is crossbar's canonical
 * format, so this is a passthrough plus model rewriting and quirk stripping.
 */
export class OpenAIAdapter implements ProviderAdapter {
  /**
   * Configurable because a great many providers speak the OpenAI dialect --
   * OpenRouter, Groq, DeepSeek, xAI, Mistral, Together and most self-hosted
   * servers. One adapter registered under several ids reaches all of them,
   * which is why adding a provider is usually a row of configuration rather
   * than a file of code.
   */
  readonly id: string;
  readonly #opts: AdapterOptions;
  /** One client per base URL -- see the note on the Anthropic adapter. */
  readonly #clients = new Map<string, OpenAI>();

  constructor(opts: AdapterOptions & { id?: string } = {}) {
    this.id = opts.id ?? "openai";
    this.#opts = opts;
  }

  #clientFor(endpoint: Endpoint): OpenAI {
    const baseUrl = endpoint.baseUrl ?? this.#opts.baseUrl ?? "";
    let client = this.#clients.get(baseUrl);
    if (!client) {
      client = new OpenAI({
        apiKey: this.#opts.apiKey ?? `missing-${this.id}-api-key`,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(this.#opts.fetch ? { fetch: this.#opts.fetch } : {}),
      });
      this.#clients.set(baseUrl, client);
    }
    return client;
  }

  #params(request: ChatCompletionRequest, endpoint: Endpoint): Record<string, unknown> {
    const params: Record<string, unknown> = {
      model: endpoint.upstreamModelId,
      // `reasoning_content` is a crossbar-side field; it must not go upstream.
      messages: request.messages.map((m) =>
        m.role === "assistant" ? stripReasoning(m) : m,
      ),
      max_completion_tokens: resolveMaxTokens(request, endpoint),
    };

    if (request.temperature !== undefined && !isUnsupported(endpoint, "temperature"))
      params.temperature = request.temperature;
    if (request.top_p !== undefined && !isUnsupported(endpoint, "top_p"))
      params.top_p = request.top_p;
    if (request.stop !== undefined) params.stop = request.stop;
    if (request.seed !== undefined) params.seed = request.seed;
    if (request.frequency_penalty !== undefined) params.frequency_penalty = request.frequency_penalty;
    if (request.presence_penalty !== undefined) params.presence_penalty = request.presence_penalty;
    if (request.user !== undefined) params.user = request.user;

    if (request.tools?.length && endpoint.supportsTools) {
      params.tools = request.tools;
      if (
        request.tool_choice !== undefined &&
        !isUnsupported(endpoint, "tool_choice", toolChoiceVariant(request.tool_choice))
      ) {
        params.tool_choice = request.tool_choice;
      }
      if (request.parallel_tool_calls !== undefined)
        params.parallel_tool_calls = request.parallel_tool_calls;
    }

    if (request.response_format !== undefined) params.response_format = request.response_format;

    const effort = clampEffort(request.reasoning_effort);
    if (effort && endpoint.supportsReasoning) params.reasoning_effort = effort;

    return params;
  }

  async invoke(
    request: ChatCompletionRequest,
    endpoint: Endpoint,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    const res = (await this.#clientFor(endpoint).chat.completions.create(
      { ...this.#params(request, endpoint), stream: false } as never,
      { signal },
    )) as unknown as ChatCompletion;

    return {
      ...res,
      object: "chat.completion",
      model: request.model,
      provider: this.id,
      usage: normalizeUsage(res.usage as unknown as Record<string, unknown> | undefined),
    };
  }

  async *invokeStream(
    request: ChatCompletionRequest,
    endpoint: Endpoint,
    signal: AbortSignal,
  ): AsyncIterable<ChatCompletionChunk> {
    const stream = (await this.#clientFor(endpoint).chat.completions.create(
      {
        ...this.#params(request, endpoint),
        stream: true,
        stream_options: { include_usage: true },
      } as never,
      { signal },
    )) as unknown as AsyncIterable<Record<string, unknown>>;

    for await (const raw of stream) {
      const chunk = raw as unknown as ChatCompletionChunk;
      yield {
        ...chunk,
        object: "chat.completion.chunk",
        model: request.model,
        provider: this.id,
        choices: (chunk.choices ?? []).map((c) => ({
          index: c.index ?? 0,
          delta: c.delta ?? {},
          finish_reason: (c.finish_reason ?? null) as FinishReason,
        })),
        usage: chunk.usage
          ? normalizeUsage(chunk.usage as unknown as Record<string, unknown>)
          : null,
      };
    }
  }

  classifyError(err: unknown): CrossbarError {
    return classifyProviderError(err, this.id);
  }
}

function stripReasoning<T extends { reasoning_content?: unknown }>(m: T): T {
  if (m.reasoning_content === undefined) return m;
  const { reasoning_content: _drop, ...rest } = m;
  return rest as T;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function normalizeUsage(usage: Record<string, unknown> | undefined): Usage {
  const prompt = num(usage?.prompt_tokens);
  const completion = num(usage?.completion_tokens);
  const promptDetails = usage?.prompt_tokens_details as Record<string, unknown> | undefined;
  const completionDetails = usage?.completion_tokens_details as Record<string, unknown> | undefined;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: num(usage?.total_tokens) || prompt + completion,
    prompt_tokens_details: { cached_tokens: num(promptDetails?.cached_tokens) },
    completion_tokens_details: { reasoning_tokens: num(completionDetails?.reasoning_tokens) },
  };
}
