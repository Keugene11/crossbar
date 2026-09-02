import { CrossbarError } from "../../errors.js";
import type { Endpoint } from "../../registry/catalog.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
} from "../../schemas/openai.js";
import { classifyProviderError } from "../classify.js";
import { completionId, nowSeconds, resolveMaxTokens, textOf } from "../common.js";
import type { AdapterOptions, ProviderAdapter } from "../types.js";

/**
 * A provider that answers without calling anything.
 *
 * Every other adapter needs credentials, which makes the gateway impossible to
 * try -- or to write a client against -- until you have an account with someone.
 * This one closes that gap: it exercises the whole path (routing, streaming,
 * usage accounting, the generation ledger) and returns a canned reply.
 *
 * It is labelled a demo model everywhere it appears, and priced at zero, so it
 * cannot be mistaken for a real one.
 */
export class EchoAdapter implements ProviderAdapter {
  readonly id = "crossbar";
  readonly #delayMs: number;

  constructor(opts: AdapterOptions & { delayMs?: number } = {}) {
    // A little latency per chunk so streaming looks like streaming.
    this.#delayMs = opts.delayMs ?? 45;
  }

  #reply(request: ChatCompletionRequest): string {
    const last = [...request.messages].reverse().find((m) => m.role === "user");
    const prompt = textOf(last?.content).trim();

    if (!prompt) return "This is crossbar's demo model. Send it a message and it will echo back.";
    return (
      `You said: "${prompt}"\n\n` +
      "This is crossbar's built-in demo model. It answers without calling any " +
      "upstream provider, so you can exercise routing, streaming and usage " +
      "accounting without credentials. Point `model` at a real id like " +
      "`anthropic/claude-opus-5` once you have provider keys configured."
    );
  }

  /** Rough but self-consistent, so reported usage and cost stay coherent. */
  #tokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  }

  async invoke(
    request: ChatCompletionRequest,
    endpoint: Endpoint,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    if (signal.aborted) throw new CrossbarError({ status: 499, code: "cancelled", message: "Cancelled" });

    const text = this.#reply(request).slice(0, resolveMaxTokens(request, endpoint) * 4);
    const promptTokens = this.#tokens(request.messages.map((m) => textOf(m.content)).join(" "));

    return {
      id: completionId(),
      object: "chat.completion",
      created: nowSeconds(),
      model: request.model,
      provider: this.id,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: this.#tokens(text),
        total_tokens: promptTokens + this.#tokens(text),
      },
    };
  }

  async *invokeStream(
    request: ChatCompletionRequest,
    endpoint: Endpoint,
    signal: AbortSignal,
  ): AsyncIterable<ChatCompletionChunk> {
    const text = this.#reply(request).slice(0, resolveMaxTokens(request, endpoint) * 4);
    const promptTokens = this.#tokens(request.messages.map((m) => textOf(m.content)).join(" "));
    const id = completionId();
    const created = nowSeconds();

    const base = {
      id,
      object: "chat.completion.chunk" as const,
      created,
      model: request.model,
      provider: this.id,
    };

    yield { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] };

    // Word-at-a-time, so a client sees the same shape a real model produces.
    const words = text.split(/(\s+)/).filter(Boolean);
    for (const word of words) {
      if (signal.aborted) return;
      if (this.#delayMs > 0) await new Promise((r) => setTimeout(r, this.#delayMs));
      yield { ...base, choices: [{ index: 0, delta: { content: word }, finish_reason: null }] };
    }

    yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    yield {
      ...base,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: this.#tokens(text),
        total_tokens: promptTokens + this.#tokens(text),
      },
    };
  }

  classifyError(err: unknown): CrossbarError {
    return classifyProviderError(err, this.id);
  }
}
