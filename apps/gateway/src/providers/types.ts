import type { Endpoint } from "../registry/catalog.js";
import type { CrossbarError } from "../errors.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
} from "../schemas/openai.js";

export interface AdapterOptions {
  apiKey?: string | undefined;
  /** Overrides the SDK default and the endpoint's own `baseUrl`. Used by tests. */
  baseUrl?: string | undefined;
  /**
   * Replaces the SDK's transport. Tests pass a fake upstream's `fetch` here so
   * the whole adapter runs in-process with no ports and no network.
   */
  fetch?: typeof globalThis.fetch | undefined;
}

/**
 * A provider adapter is the only place that knows a vendor's dialect.
 *
 * Everything above it -- routing, cascade, accounting -- speaks OpenAI Chat
 * Completions exclusively, which is why adding a provider is a single file.
 */
export interface ProviderAdapter {
  readonly id: string;

  invoke(
    request: ChatCompletionRequest,
    endpoint: Endpoint,
    signal: AbortSignal,
  ): Promise<ChatCompletion>;

  invokeStream(
    request: ChatCompletionRequest,
    endpoint: Endpoint,
    signal: AbortSignal,
  ): AsyncIterable<ChatCompletionChunk>;

  /** Turn a vendor SDK throw into the shared taxonomy the cascade understands. */
  classifyError(err: unknown): CrossbarError;
}

export type AdapterFactory = (opts: AdapterOptions) => ProviderAdapter;

export class ProviderRegistry {
  #adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    this.#adapters.set(adapter.id, adapter);
    return this;
  }

  has(id: string): boolean {
    return this.#adapters.has(id);
  }

  get(id: string): ProviderAdapter | undefined {
    return this.#adapters.get(id);
  }

  ids(): string[] {
    return [...this.#adapters.keys()];
  }
}
