import { CrossbarError, codeForStatus } from "../errors.js";

/**
 * One classifier for every provider SDK.
 *
 * The OpenAI and Anthropic clients are generated from the same template and so
 * expose structurally identical error hierarchies -- but they are separate
 * packages, so `err instanceof OpenAI.APIError` is always false for an
 * Anthropic throw. Matching on the shape instead of the class avoids that trap
 * and means a third provider needs no new branch here.
 */

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  error?: unknown;
}

function shapeOf(err: unknown): ErrorLike {
  return (err ?? {}) as ErrorLike;
}

/**
 * The SDKs subclass Error but leave `name` as "Error", so the class identity
 * only survives on the constructor. Check both, and never rely on `name` alone.
 */
function errorKind(err: unknown): string {
  const { name } = shapeOf(err);
  const ctor = (err as { constructor?: { name?: string } } | null)?.constructor?.name;
  return typeof ctor === "string" && ctor !== "Error" ? ctor : String(name ?? "");
}

/** Transport failures surfaced as a plain Error by fetch or the SDK wrapper. */
const CONNECTION_MESSAGE =
  /connection error|fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|network|premature close|terminated/i;

function isAbort(err: unknown): boolean {
  const kind = errorKind(err);
  return kind === "AbortError" || kind === "APIUserAbortError";
}

export function classifyProviderError(err: unknown, providerName: string): CrossbarError {
  if (err instanceof CrossbarError) return err;

  const { status, error: raw } = shapeOf(err);
  const kind = errorKind(err);
  const message = err instanceof Error ? err.message : String(err);

  if (isAbort(err)) {
    return new CrossbarError({
      status: 499,
      code: "cancelled",
      message: "Request cancelled",
      retryable: false,
      providerName,
      cause: err,
    });
  }

  if (kind === "APIConnectionTimeoutError") {
    return new CrossbarError({
      status: 408,
      code: "timeout",
      message: `${providerName}: upstream timed out`,
      retryable: true,
      providerName,
      cause: err,
    });
  }

  if (kind === "APIConnectionError" || (typeof status !== "number" && CONNECTION_MESSAGE.test(message))) {
    return new CrossbarError({
      status: 503,
      code: "connection",
      message: `${providerName}: ${message}`,
      retryable: true,
      providerName,
      cause: err,
    });
  }

  if (typeof status === "number") {
    return new CrossbarError({
      status,
      code: codeForStatus(status),
      message: `${providerName}: ${message}`,
      providerName,
      raw,
      cause: err,
    });
  }

  // An unrecognised throw is a bug on our side or a broken upstream body.
  // Treat it as terminal: retrying the same shape elsewhere rarely helps.
  return new CrossbarError({
    status: 502,
    code: "provider_error",
    message: `${providerName}: ${message}`,
    retryable: false,
    providerName,
    cause: err,
  });
}
