import Anthropic from "@anthropic-ai/sdk";
import type { CrossbarError } from "../../errors.js";
import type { Endpoint } from "../../registry/catalog.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
} from "../../schemas/openai.js";
import { classifyProviderError } from "../classify.js";
import type { AdapterOptions, ProviderAdapter } from "../types.js";
import { toChatCompletion } from "./from-upstream.js";
import { AnthropicStreamMapper } from "./stream.js";
import { toMessageCreateParams } from "./to-upstream.js";

/**
 * Anthropic Messages API adapter.
 *
 * All dialect knowledge lives in the three sibling modules; this file is just
 * transport plus error classification.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly id = "anthropic";
  readonly #opts: AdapterOptions;
  /**
   * One client per base URL, built lazily.
   *
   * Endpoints of the same provider can live behind different hosts (a regional
   * deployment, a self-hosted gateway), and the SDK binds its base URL at
   * construction -- so the client is keyed by it rather than shared blindly.
   */
  readonly #clients = new Map<string, Anthropic>();

  constructor(opts: AdapterOptions = {}) {
    this.#opts = opts;
  }

  #clientFor(endpoint: Endpoint): Anthropic {
    const baseUrl = endpoint.baseUrl ?? this.#opts.baseUrl ?? "";
    let client = this.#clients.get(baseUrl);
    if (!client) {
      client = new Anthropic({
        apiKey: this.#opts.apiKey ?? "missing-anthropic-api-key",
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(this.#opts.fetch ? { fetch: this.#opts.fetch } : {}),
      });
      this.#clients.set(baseUrl, client);
    }
    return client;
  }

  async invoke(
    request: ChatCompletionRequest,
    endpoint: Endpoint,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    const params = toMessageCreateParams(request, endpoint);
    const message = await this.#clientFor(endpoint).messages.create(
      { ...params, stream: false },
      { signal },
    );
    return toChatCompletion(message, request.model, this.id);
  }

  async *invokeStream(
    request: ChatCompletionRequest,
    endpoint: Endpoint,
    signal: AbortSignal,
  ): AsyncIterable<ChatCompletionChunk> {
    const params = toMessageCreateParams(request, endpoint);
    const stream = await this.#clientFor(endpoint).messages.create(
      { ...params, stream: true },
      { signal },
    );
    const mapper = new AnthropicStreamMapper(request.model, this.id);

    for await (const event of stream) {
      for (const chunk of mapper.map(event)) yield chunk;
    }
    yield mapper.usageChunk();
  }

  classifyError(err: unknown): CrossbarError {
    return classifyProviderError(err, this.id);
  }
}
