import type { MiddlewareHandler } from "hono";
import { CrossbarError } from "./errors.js";
import type { AuthVariables } from "./auth.js";

/**
 * Per-caller token bucket.
 *
 * A bucket rather than a fixed window: a fixed window lets a caller spend its
 * whole quota in the last instant of one window and again in the first instant
 * of the next, producing a burst of twice the nominal rate against upstream
 * providers that bill for it.
 */
export interface RateLimitOptions {
  /** Sustained requests per minute per caller. Zero disables the limiter. */
  requestsPerMinute: number;
  /** Bucket depth. Defaults to a quarter-minute of burst. */
  burst?: number;
  now?: () => number;
  /** Buckets idle this long are eligible for eviction. */
  idleEvictionMs?: number;
  maxTrackedCallers?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimiter {
  /** Consume one token. Returns null when allowed, or seconds to wait. */
  check(caller: string): number | null;
  size(): number;
}

export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const rpm = opts.requestsPerMinute;
  const capacity = Math.max(opts.burst ?? Math.ceil(rpm / 4), 1);
  const refillPerMs = rpm / 60_000;
  const now = opts.now ?? Date.now;
  const idleMs = opts.idleEvictionMs ?? 10 * 60_000;
  const maxCallers = opts.maxTrackedCallers ?? 100_000;

  const buckets = new Map<string, Bucket>();

  /**
   * The bucket map is itself an attack surface: unauthenticated callers are
   * keyed by IP, so without eviction a spoofed-header flood grows it without
   * bound. Sweeping idle entries keeps memory proportional to active callers.
   */
  function evictIdle(at: number): void {
    for (const [key, bucket] of buckets) {
      if (at - bucket.updatedAt > idleMs) buckets.delete(key);
    }
  }

  return {
    check(caller: string): number | null {
      if (rpm <= 0) return null;
      const at = now();

      let bucket = buckets.get(caller);
      if (!bucket) {
        if (buckets.size >= maxCallers) {
          evictIdle(at);
          // Still full of active callers: shed rather than grow without bound.
          if (buckets.size >= maxCallers) return Math.ceil(1 / refillPerMs / 1000);
        }
        bucket = { tokens: capacity, updatedAt: at };
        buckets.set(caller, bucket);
      }

      const elapsed = at - bucket.updatedAt;
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.updatedAt = at;

      if (bucket.tokens < 1) {
        const waitMs = (1 - bucket.tokens) / refillPerMs;
        return Math.max(Math.ceil(waitMs / 1000), 1);
      }

      bucket.tokens -= 1;
      return null;
    },

    size: () => buckets.size,
  };
}

/**
 * Identify the caller.
 *
 * Prefers the authenticated key. Falling back to a forwarded IP is a weaker
 * signal -- the header is caller-controlled and only trustworthy behind a proxy
 * that overwrites it -- but it is better than letting unauthenticated traffic
 * share one global bucket, where a single client could starve everyone else.
 */
export function callerId(keyId: string | null, forwardedFor: string | undefined): string {
  if (keyId) return keyId;
  const first = forwardedFor?.split(",")[0]?.trim();
  return first ? `ip:${first}` : "anonymous";
}

export function rateLimit(
  limiter: RateLimiter,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const caller = callerId(c.get("keyId") ?? null, c.req.header("x-forwarded-for"));
    const retryAfter = limiter.check(caller);

    if (retryAfter !== null) {
      c.header("retry-after", String(retryAfter));
      throw new CrossbarError({
        status: 429,
        code: "rate_limited",
        message: `Rate limit exceeded. Retry in ${retryAfter}s.`,
        retryable: true,
      });
    }
    return next();
  };
}
