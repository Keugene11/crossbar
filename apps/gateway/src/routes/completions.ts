import type { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, AppEnv } from "../app.js";
import { CrossbarError } from "../errors.js";
import { LIMITS, ReasoningEffort } from "../schemas/openai.js";
import { ProviderPreferences } from "../schemas/routing.js";

/**
 * The legacy text-completion endpoint.
 *
 * OpenRouter serves it, and enough older clients still speak it that supporting
 * it is cheap compatibility. It is a thin shim: the prompt becomes a single
 * user message, the request is handled by the ordinary chat pipeline, and the
 * response is rewritten back into the older shape. No routing, translation, or
 * accounting logic is duplicated.
 */
export const CompletionRequest = z
  .object({
    model: z.string().min(1).max(LIMITS.modelIdLength),
    prompt: z.union([z.string(), z.array(z.string()).max(1)]),

    stream: z.boolean().default(false),
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().positive().optional(),
    stop: z.union([z.string(), z.array(z.string()).max(LIMITS.stopSequences)]).optional(),
    seed: z.number().int().optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    reasoning_effort: ReasoningEffort.optional(),
    user: z.string().optional(),

    models: z.array(z.string().max(LIMITS.modelIdLength)).max(LIMITS.fallbackModels).optional(),
    provider: ProviderPreferences.optional(),
    usage: z.object({ include: z.boolean() }).optional(),
  })
  .strict();

/**
 * The subset of a fetch Response this shim touches.
 *
 * Declared structurally rather than relying on the ambient `Response`: the
 * serverless builder compiles this file against a different lib than the
 * workspace does, and there `Response` lacks `json()`. Naming what we use
 * keeps the file honest and portable across both.
 */
interface UpstreamResponse {
  ok: boolean;
  status: number;
  headers: Iterable<[string, string]>;
  json(): Promise<unknown>;
}

/** Rewrite a chat completion body into the legacy text-completion shape. */
function toLegacy(body: Record<string, unknown>): Record<string, unknown> {
  const choices = (body.choices as Array<Record<string, any>> | undefined) ?? [];
  return {
    ...body,
    object: "text_completion",
    choices: choices.map((c) => ({
      index: c.index ?? 0,
      text: c.message?.content ?? c.delta?.content ?? "",
      finish_reason: c.finish_reason ?? null,
      logprobs: null,
    })),
  };
}

export function registerCompletionRoute(app: Hono<AppEnv>, _deps: AppDeps): void {
  app.post("/completions", async (c) => {
    const parsed = CompletionRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new CrossbarError({
        status: 400,
        code: "invalid_request",
        message: first ? `${first.path.join(".") || "body"}: ${first.message}` : "Invalid body",
        retryable: false,
      });
    }

    const { prompt, ...rest } = parsed.data;
    const text = Array.isArray(prompt) ? (prompt[0] ?? "") : prompt;

    // Re-enter the app through the chat route so this endpoint can never drift
    // from it: same auth, same rate limit, same routing, same ledger.
    const upstream = (await app.request(
      "/chat/completions",
      {
        method: "POST",
        headers: c.req.raw.headers,
        body: JSON.stringify({ ...rest, messages: [{ role: "user", content: text }] }),
        signal: c.req.raw.signal,
      },
      c.env,
    )) as unknown as UpstreamResponse;

    if (!upstream.ok || parsed.data.stream) {
      // Errors keep their envelope, and streamed bodies pass through untouched:
      // rewriting SSE chunk shapes for a legacy endpoint is not worth the risk
      // of corrupting a live stream.
      return upstream as unknown as Response;
    }

    const body = (await upstream.json()) as Record<string, unknown>;
    return c.json(toLegacy(body), 200, Object.fromEntries(upstream.headers));
  });
}
