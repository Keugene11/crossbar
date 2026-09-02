import { CrossbarError, retryActionFor, truncate, type AttemptRecord } from "../errors.js";
import type { Endpoint } from "../registry/catalog.js";
import type { ProviderRegistry } from "../providers/types.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
} from "../schemas/openai.js";
import type { StatsTracker } from "./stats.js";

export interface ExecuteDeps {
  providers: ProviderRegistry;
  stats: StatsTracker;
  /** Budget for an attempt to produce its first output, in ms. */
  ttftTimeoutMs: number;
  /** Budget for a whole buffered (non-streaming) attempt, in ms. */
  attemptTimeoutMs: number;
  now?: () => number;
}

interface ExecuteBase {
  endpoint: Endpoint;
  attempts: AttemptRecord[];
  ttftMs: number;
}

export interface BufferedResult extends ExecuteBase {
  kind: "buffered";
  completion: ChatCompletion;
}

export interface StreamedResult extends ExecuteBase {
  kind: "streamed";
  /** Already primed: the first chunk has arrived, so the endpoint is committed. */
  stream: AsyncIterable<ChatCompletionChunk>;
}

/** Raised once output has been committed to the client and cannot be replayed. */
export class MidStreamError extends Error {
  readonly inner: CrossbarError;
  constructor(inner: CrossbarError) {
    super(inner.message, { cause: inner });
    this.name = "MidStreamError";
    this.inner = inner;
  }
}

interface AttemptSignal {
  signal: AbortSignal;
  /** Cancel the deadline but keep client-disconnect propagation alive. */
  clearTimer: () => void;
  /** Cancel the deadline and stop propagating. */
  dispose: () => void;
}

/**
 * An attempt-scoped signal that aborts on either the deadline or a client
 * disconnect.
 *
 * The two are torn down separately on purpose. Once a stream has produced its
 * first chunk the deadline must go -- a long generation is not a stall -- but
 * disconnect propagation has to survive for the life of the stream, or a client
 * that hangs up leaves the upstream generating tokens we still pay for.
 */
function linkSignals(signal: AbortSignal, timeoutMs: number): AttemptSignal {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => controller.abort(new Error("attempt timed out")),
    timeoutMs,
  );
  const onAbort = (): void => controller.abort(signal.reason);

  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return {
    signal: controller.signal,
    clearTimer,
    dispose: () => {
      clearTimer();
      signal.removeEventListener("abort", onAbort);
    },
  };
}

/** Distinguish "we gave up waiting" from "the client went away". */
function timeoutError(providerName: string, clientSignal: AbortSignal): CrossbarError {
  if (clientSignal.aborted) {
    return new CrossbarError({
      status: 499,
      code: "cancelled",
      message: "Client disconnected",
      retryable: false,
      providerName,
    });
  }
  return new CrossbarError({
    status: 408,
    code: "timeout",
    message: `${providerName}: no response within the attempt budget`,
    retryable: true,
    providerName,
  });
}

/**
 * Run the cascade.
 *
 * The invariant that shapes everything: **once a byte reaches the client, no
 * other endpoint can be tried.** So an attempt is only "committed" when its
 * first chunk arrives. Anything that fails before that point is recorded and
 * the next candidate takes over; anything that fails after it is terminal and
 * surfaces as `MidStreamError` for the caller to render inside the open stream.
 */
export async function executeCascade(
  request: ChatCompletionRequest,
  candidates: Endpoint[],
  deps: ExecuteDeps,
  clientSignal: AbortSignal,
): Promise<BufferedResult | StreamedResult> {
  const now = deps.now ?? Date.now;
  const attempts: AttemptRecord[] = [];
  let lastError: CrossbarError | undefined;
  /** Providers whose credentials were rejected; their endpoints are dead too. */
  const blockedProviders = new Set<string>();

  for (const endpoint of candidates) {
    if (blockedProviders.has(endpoint.provider)) continue;

    const adapter = deps.providers.get(endpoint.provider);
    if (!adapter) {
      attempts.push({
        endpointId: endpoint.id,
        provider: endpoint.provider,
        upstreamModel: endpoint.upstreamModelId,
        latencyMs: 0,
        error: {
          code: "no_endpoints",
          status: 501,
          message: `No adapter registered for provider "${endpoint.provider}"`,
        },
      });
      continue;
    }

    const startedAt = now();
    const budget = request.stream ? deps.ttftTimeoutMs : deps.attemptTimeoutMs;
    const link = linkSignals(clientSignal, budget);

    try {
      if (!request.stream) {
        const completion = await adapter.invoke(request, endpoint, link.signal);
        const latencyMs = now() - startedAt;
        link.dispose();

        deps.stats.recordSuccess(endpoint.id, { ttftMs: latencyMs });
        attempts.push(record(endpoint, latencyMs, null));
        return { kind: "buffered", endpoint, attempts, ttftMs: latencyMs, completion };
      }

      const iterator = adapter.invokeStream(request, endpoint, link.signal)[Symbol.asyncIterator]();
      const first = await iterator.next();
      const ttftMs = now() - startedAt;
      // Drop the TTFT deadline only: a long generation is not a stall. Client
      // disconnect must keep propagating, so `link` is disposed by `resume`
      // when the stream finally ends.
      link.clearTimer();

      deps.stats.recordSuccess(endpoint.id, { ttftMs });
      attempts.push(record(endpoint, ttftMs, null));

      return {
        kind: "streamed",
        endpoint,
        attempts,
        ttftMs,
        stream: resume(iterator, first, adapter.classifyError.bind(adapter), link),
      };
    } catch (err) {
      link.dispose();
      const latencyMs = now() - startedAt;

      const normalized =
        err instanceof Error && err.name === "AbortError" && !clientSignal.aborted
          ? timeoutError(endpoint.provider, clientSignal)
          : adapter.classifyError(err);

      if (normalized.code === "cancelled") throw attachAttempts(normalized, attempts);

      lastError = normalized;
      deps.stats.recordFailure(endpoint.id);
      attempts.push(
        record(endpoint, latencyMs, {
          code: normalized.code,
          status: normalized.status,
          // Bounded: this lands in a jsonb column on every attempt.
          message: truncate(normalized.message, 500),
        }),
      );

      switch (retryActionFor(normalized.status)) {
        case "skip-provider":
          // Same key on every endpoint of this provider -- skip them all, but
          // a different provider may still serve the request.
          blockedProviders.add(endpoint.provider);
          break;
        case "retry-next":
          break;
        case "terminal":
          // A client disconnect or a malformed request fails identically
          // everywhere, so stop rather than burn the chain.
          throw attachAttempts(normalized, attempts);
      }
    }
  }

  throw attachAttempts(
    new CrossbarError({
      status: lastError ? statusForExhausted(lastError) : 502,
      code: "all_providers_failed",
      message: lastError
        ? `All ${attempts.length} endpoint(s) failed; last error: ${lastError.message}`
        : "No endpoint could serve this request",
      retryable: false,
    }),
    attempts,
  );
}

/**
 * Preserve a status the client can act on through exhaustion: 429 means back
 * off, 401 means fix the credentials. Anything else collapses to 502.
 */
function statusForExhausted(last: CrossbarError): number {
  if (last.status === 429 || last.status === 401 || last.status === 403) return last.status;
  return 502;
}

function record(
  endpoint: Endpoint,
  latencyMs: number,
  error: AttemptRecord["error"],
): AttemptRecord {
  return {
    endpointId: endpoint.id,
    provider: endpoint.provider,
    upstreamModel: endpoint.upstreamModelId,
    latencyMs,
    error,
  };
}

function attachAttempts(err: CrossbarError, attempts: AttemptRecord[]): CrossbarError {
  return new CrossbarError({
    status: err.status,
    code: err.code,
    message: err.message,
    retryable: err.retryable,
    providerName: err.providerName,
    attempts,
    raw: err.raw,
    cause: err,
  });
}

/**
 * Replay the already-consumed first chunk, then drain the rest.
 *
 * The `finally` matters as much as the body: when the consumer stops early --
 * a disconnected client, a thrown error downstream -- the generator is closed
 * without `iterator.next()` ever returning done, so the upstream connection is
 * only released if we return the iterator ourselves.
 */
async function* resume(
  iterator: AsyncIterator<ChatCompletionChunk>,
  first: IteratorResult<ChatCompletionChunk>,
  classify: (err: unknown) => CrossbarError,
  link: AttemptSignal,
): AsyncIterable<ChatCompletionChunk> {
  try {
    if (first.done) return;
    yield first.value;

    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  } catch (err) {
    throw new MidStreamError(classify(err));
  } finally {
    try {
      await iterator.return?.();
    } catch {
      // Best effort: the upstream may already be gone.
    }
    link.dispose();
  }
}
