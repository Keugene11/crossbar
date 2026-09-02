/**
 * Normalized error taxonomy.
 *
 * Every upstream failure is funnelled through `CrossbarError` so the cascade
 * driver can make one decision -- retry this endpoint's successor, or stop --
 * without knowing which provider SDK threw.
 */

export type ErrorCode =
  | "invalid_request"
  | "authentication"
  | "permission"
  | "not_found"
  | "context_length_exceeded"
  | "rate_limited"
  | "provider_error"
  | "overloaded"
  | "timeout"
  | "connection"
  | "no_endpoints"
  | "all_providers_failed"
  | "cancelled"
  | "internal";

export interface AttemptRecord {
  endpointId: string;
  provider: string;
  upstreamModel: string;
  latencyMs: number;
  error: { code: ErrorCode; status: number; message: string } | null;
}

export interface CrossbarErrorInit {
  status: number;
  code: ErrorCode;
  message: string;
  /** Whether trying a different endpoint could plausibly succeed. */
  retryable?: boolean;
  providerName?: string;
  attempts?: AttemptRecord[];
  raw?: unknown;
  cause?: unknown;
}

export class CrossbarError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly providerName: string | undefined;
  readonly attempts: AttemptRecord[] | undefined;
  readonly raw: unknown;

  constructor(init: CrossbarErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "CrossbarError";
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable ?? defaultRetryable(init.status);
    this.providerName = init.providerName;
    this.attempts = init.attempts;
    this.raw = init.raw;
  }
}

/**
 * What the cascade should do next, given how an attempt failed.
 *
 * `skip-provider` exists because credentials are per-provider, not per-request:
 * an expired Anthropic key says nothing about the OpenAI key, so the cascade
 * should abandon that provider's endpoints and carry on rather than fail the
 * whole request. Retrying the same provider would just reuse the same key.
 */
export type RetryAction =
  /** Try the next candidate endpoint. */
  | "retry-next"
  /** Drop every remaining endpoint of this provider, then continue. */
  | "skip-provider"
  /** Stop -- no other endpoint can do better. */
  | "terminal";

export function retryActionFor(status: number): RetryAction {
  // Credential and permission failures are a property of the provider account.
  if (status === 401 || status === 403) return "skip-provider";

  // The upstream does not know this model id; another provider may.
  if (status === 404) return "retry-next";

  if (status === 408 || status === 429 || status >= 500) return "retry-next";

  // 400 / 413 / 422 and friends: the request itself is the problem, and it
  // will be rejected identically everywhere. Failing fast beats burning the
  // chain and multiplying latency and upstream spend.
  return "terminal";
}

export function defaultRetryable(status: number): boolean {
  return retryActionFor(status) !== "terminal";
}

/** Map an HTTP status from any provider onto the shared code vocabulary. */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
      return "authentication";
    case 403:
      return "permission";
    case 404:
      return "not_found";
    case 408:
      return "timeout";
    case 413:
      return "context_length_exceeded";
    case 429:
      return "rate_limited";
    case 529:
      return "overloaded";
    default:
      return status >= 500 ? "provider_error" : "invalid_request";
  }
}

/**
 * Upstream error bodies are echoed to clients and stored on every attempt
 * record, so they are truncated: a provider returning a megabyte of HTML must
 * not become a megabyte in our response and a megabyte per row in Postgres.
 */
export const MAX_ERROR_MESSAGE = 2_000;
const MAX_RAW_BYTES = 4_000;

export function truncate(message: string, max = MAX_ERROR_MESSAGE): string {
  return message.length <= max ? message : `${message.slice(0, max)}... [truncated]`;
}

function boundedRaw(raw: unknown): unknown {
  if (raw === undefined) return undefined;
  try {
    const json = JSON.stringify(raw);
    if (json === undefined) return undefined;
    return json.length <= MAX_RAW_BYTES ? raw : `${json.slice(0, MAX_RAW_BYTES)}... [truncated]`;
  } catch {
    return undefined;
  }
}

export interface ErrorEnvelope {
  error: {
    message: string;
    type: ErrorCode;
    code: ErrorCode;
    metadata?: {
      provider_name?: string;
      attempts?: AttemptRecord[];
      raw?: unknown;
    };
  };
}

/** Render any thrown value as the OpenAI-shaped error body clients expect. */
export function toErrorEnvelope(err: unknown): { status: number; body: ErrorEnvelope } {
  if (err instanceof CrossbarError) {
    const metadata: NonNullable<ErrorEnvelope["error"]["metadata"]> = {};
    if (err.providerName) metadata.provider_name = err.providerName;
    if (err.attempts?.length) metadata.attempts = err.attempts;
    const raw = boundedRaw(err.raw);
    if (raw !== undefined) metadata.raw = raw;
    return {
      status: err.status,
      body: {
        error: {
          message: truncate(err.message),
          type: err.code,
          code: err.code,
          ...(Object.keys(metadata).length ? { metadata } : {}),
        },
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: { error: { message: truncate(message), type: "internal", code: "internal" } },
  };
}
