import type { Context, Hono } from "hono";
import type { AppDeps, AppEnv } from "../app.js";
import { costMicro, microToUsd } from "../accounting/cost.js";
import { recordGeneration, type GenerationDraft } from "../accounting/record.js";
import { CrossbarError, toErrorEnvelope, type AttemptRecord } from "../errors.js";
import { generationId } from "../providers/common.js";
import type { Endpoint } from "../registry/catalog.js";
import { buildCandidates } from "../routing/candidates.js";
import { executeCascade, MidStreamError } from "../routing/execute.js";
import { AUTO_MODEL_ID, resolveAuto } from "../routing/auto.js";
import { estimatePromptTokens } from "../routing/tokens.js";
import { applyVariant, parseModelRef, requiredCapabilities } from "../routing/variants.js";
import { defaultProviderPreferences } from "../schemas/routing.js";
import {
  ChatCompletionRequest,
  type ChatCompletionChunk,
  type FinishReason,
  type Usage,
} from "../schemas/openai.js";
import { SSE_DONE, SSE_HEADERS, sseChunk, sseData } from "../stream/sse.js";

function parseRequest(body: unknown): ChatCompletionRequest {
  const parsed = ChatCompletionRequest.safeParse(body);
  if (parsed.success) return parsed.data;

  const first = parsed.error.issues[0];
  throw new CrossbarError({
    status: 400,
    code: "invalid_request",
    message: first
      ? `${first.path.join(".") || "body"}: ${first.message}`
      : "Invalid request body",
    retryable: false,
    raw: parsed.error.issues,
  });
}

function routingHeaders(
  generation: string,
  endpoint: Endpoint | null,
  attempts: AttemptRecord[],
): Record<string, string> {
  return {
    "x-crossbar-generation-id": generation,
    ...(endpoint
      ? {
          "x-crossbar-provider": endpoint.provider,
          "x-crossbar-model": endpoint.upstreamModelId,
          "x-crossbar-endpoint": endpoint.id,
        }
      : {}),
    "x-crossbar-attempts": String(attempts.length),
  };
}

/** Attacker-controlled header, bounded before it reaches the database. */
function header(value: string | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 512);
}

function wantsUsage(request: ChatCompletionRequest): boolean {
  return request.usage?.include === true || request.stream_options?.include_usage === true;
}

export function registerChatRoute(app: Hono<AppEnv>, deps: AppDeps): void {
  app.post("/chat/completions", async (c) => {
    const genId = generationId();
    c.set("generationId", genId);
    const keyId = c.get("keyId") ?? null;
    // App attribution, the same headers OpenRouter reads. Bounded because they
    // are attacker-controlled and land in a database column.
    const appReferer = header(c.req.header("http-referer"));
    const appTitle = header(c.req.header("x-title"));
    const startedAt = Date.now();

    const request = parseRequest(await c.req.json().catch(() => null));
    await deps.catalog.ensureFresh();

    // `model` may carry a variant suffix (:nitro / :floor); resolve it to the
    // catalog id plus the sort it implies before anything else looks at it.
    const ref = parseModelRef(request.model);
    const prefs = applyVariant(request.provider ?? defaultProviderPreferences, ref.variant);

    // `crossbar/auto` resolves to a concrete model before anything else runs,
    // so every downstream stage sees an ordinary named-model request.
    let modelId = ref.id;
    if (modelId === AUTO_MODEL_ID) {
      const chosen = resolveAuto(deps.catalog, {
        request,
        costTier: request.cost_tier ?? "medium",
        allowedModels: request.allowed_models ?? [],
      });
      if (!chosen) {
        throw new CrossbarError({
          status: 404,
          code: "not_found",
          message: "No model in the catalog can serve this request under the given constraints",
          retryable: false,
        });
      }
      modelId = chosen;
    }

    const plan = buildCandidates(
      deps.catalog,
      modelId,
      request.models?.map((m) => parseModelRef(m).id),
      prefs,
      { stats: deps.stats, random: deps.random ?? Math.random },
      requiredCapabilities(request),
      {
        promptTokens: estimatePromptTokens(request),
        maxOutputTokens: request.max_completion_tokens ?? request.max_tokens ?? 0,
      },
    );

    // Awaited rather than fire-and-forget: the generation id ships in the
    // response headers, so a client that immediately calls /v1/generation must
    // not race the insert. recordGeneration swallows its own errors, so this
    // can never turn a successful completion into a failure.
    const finish = (
      draft: Omit<GenerationDraft, "id" | "keyId" | "requestedModel" | "appReferer" | "appTitle">,
    ): Promise<void> =>
      recordGeneration(deps.db, {
        id: genId,
        keyId,
        appReferer,
        appTitle,
        requestedModel: request.model,
        ...draft,
      });

    let result;
    try {
      result = await executeCascade(
        request,
        plan.endpoints,
        {
          providers: deps.providers,
          stats: deps.stats,
          ttftTimeoutMs: deps.ttftTimeoutMs,
          attemptTimeoutMs: deps.attemptTimeoutMs,
        },
        c.req.raw.signal,
      );
    } catch (err) {
      const e = err instanceof CrossbarError ? err : undefined;
      await finish({
        endpoint: null,
        streamed: request.stream,
        finishReason: "error",
        usage: null,
        latencyMs: Date.now() - startedAt,
        ttftMs: null,
        attempts: e?.attempts ?? [],
        error: e ? { code: e.code, status: e.status, message: e.message } : null,
      });
      throw err;
    }

    const headers = routingHeaders(genId, result.endpoint, result.attempts);

    if (result.kind === "buffered") {
      const usage: Usage = {
        ...result.completion.usage,
        cost: microToUsd(costMicro(result.completion.usage, result.endpoint)),
      };
      await finish({
        endpoint: result.endpoint,
        streamed: false,
        finishReason: result.completion.choices[0]?.finish_reason ?? null,
        usage,
        latencyMs: Date.now() - startedAt,
        ttftMs: result.ttftMs,
        attempts: result.attempts,
        error: null,
      });
      return c.json({ ...result.completion, id: genId, usage }, 200, headers);
    }

    return streamResponse(c, {
      genId,
      headers,
      request,
      result,
      startedAt,
      finish,
    });
  });
}

interface StreamArgs {
  genId: string;
  headers: Record<string, string>;
  request: ChatCompletionRequest;
  result: Extract<Awaited<ReturnType<typeof executeCascade>>, { kind: "streamed" }>;
  startedAt: number;
  finish: (
    draft: Omit<GenerationDraft, "id" | "keyId" | "requestedModel" | "appReferer" | "appTitle">,
  ) => Promise<void>;
}

function streamResponse(c: Context<AppEnv>, args: StreamArgs): Response {
  const { genId, headers, request, result, startedAt, finish } = args;
  const encoder = new TextEncoder();
  const includeUsage = wantsUsage(request);

  let usage: Usage | null = null;
  let finishReason: FinishReason = null;
  let errored: CrossbarError | null = null;

  // A generation is recorded exactly once. `start` and `cancel` can both run
  // for the same stream (client hangs up mid-flush), and a second insert would
  // collide on the primary key.
  let recorded = false;
  const recordOnce = (
    draft: Omit<GenerationDraft, "id" | "keyId" | "requestedModel" | "appReferer" | "appTitle">,
  ): Promise<void> => {
    if (recorded) return Promise.resolve();
    recorded = true;
    return finish(draft);
  };

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Once the client is gone `enqueue` throws. That must not abort the rest
      // of this function -- the ledger write still has to happen.
      let open = true;
      const write = (s: string): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          open = false;
        }
      };

      try {
        for await (const chunk of result.stream) {
          finishReason = chunk.choices[0]?.finish_reason ?? finishReason;

          if (chunk.usage) {
            usage = {
              ...chunk.usage,
              cost: microToUsd(costMicro(chunk.usage, result.endpoint)),
            };
            // A usage-only frame is accounting metadata; forward it only when
            // the client opted in, but always keep it for the ledger.
            if (!includeUsage) continue;
            write(sseChunk({ ...chunk, id: genId, usage } as ChatCompletionChunk));
            continue;
          }

          write(sseChunk({ ...chunk, id: genId }));
        }
      } catch (err) {
        // Output is already committed, so the only channel left is a final
        // data frame inside the open stream. No other endpoint may be tried.
        errored =
          err instanceof MidStreamError
            ? err.inner
            : err instanceof CrossbarError
              ? err
              : new CrossbarError({
                  status: 502,
                  code: "provider_error",
                  message: err instanceof Error ? err.message : String(err),
                  retryable: false,
                });
        write(sseData(toErrorEnvelope(errored).body));
      }

      write(SSE_DONE);
      // Recorded before the stream closes so the ledger is readable the moment
      // the client sees [DONE].
      await recordOnce({
        endpoint: result.endpoint,
        streamed: true,
        finishReason: errored ? "error" : finishReason,
        usage,
        latencyMs: Date.now() - startedAt,
        ttftMs: result.ttftMs,
        attempts: result.attempts,
        error: errored
          ? { code: errored.code, status: errored.status, message: errored.message }
          : null,
      });
      if (open) controller.close();
    },

    cancel() {
      // Client hung up mid-stream; nothing more to write, but the partial
      // generation still belongs in the ledger.
      void recordOnce({
        endpoint: result.endpoint,
        streamed: true,
        finishReason: finishReason ?? "error",
        usage,
        latencyMs: Date.now() - startedAt,
        ttftMs: result.ttftMs,
        attempts: result.attempts,
        error: { code: "cancelled", status: 499, message: "Client disconnected" },
      });
    },
  });

  return new Response(body, { status: 200, headers: { ...SSE_HEADERS, ...headers } });
}
