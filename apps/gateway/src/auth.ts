import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { CrossbarError } from "./errors.js";

/**
 * Stable, non-reversible label for a key.
 *
 * Generations are attributed by this, never by the key itself, so a leaked
 * database never leaks credentials.
 */
export function keyIdFor(key: string): string {
  return `key_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Fixed-width, no-early-exit comparison against every configured key.
 *
 * Hashing both sides keeps the comparison constant-width so the loop cannot
 * leak key length, and the loop never breaks early so it cannot leak which key
 * matched. The allowed digests are precomputed at startup -- rehashing them on
 * every request was pure overhead on the hot path.
 */
function constantTimeIncludes(candidate: string, allowed: readonly Buffer[]): boolean {
  const probe = digest(candidate);
  let match = false;
  for (const known of allowed) {
    if (timingSafeEqual(probe, known)) match = true;
  }
  return match;
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() || undefined;
}

export type KeyTier = "full" | "free";

export interface AuthVariables {
  keyId: string | null;
  /** "free" keys may only reach zero-cost endpoints. */
  tier: KeyTier;
}

/**
 * Static bearer-key auth.
 *
 * v1 deliberately has no key service: keys come from configuration. The
 * contract downstream is only `c.var.keyId`, so swapping in issued keys with
 * credit balances later is a change to this file alone.
 *
 * An empty allowlist disables auth, which is what local dev and tests want.
 */
export function auth(
  apiKeys: string[],
  freeApiKeys: string[] = [],
): MiddlewareHandler<{ Variables: AuthVariables }> {
  const allowed = apiKeys.map(digest);
  const free = freeApiKeys.map(digest);
  const keyIds = new Map([...apiKeys, ...freeApiKeys].map((k) => [k, keyIdFor(k)]));

  return async (c, next) => {
    if (apiKeys.length === 0 && freeApiKeys.length === 0) {
      c.set("keyId", null);
      c.set("tier", "full");
      return next();
    }

    const token = bearerToken(c.req.header("authorization"));
    const isFree = Boolean(token) && constantTimeIncludes(token!, free);
    const isFull = Boolean(token) && constantTimeIncludes(token!, allowed);

    if (!token || (!isFree && !isFull)) {
      throw new CrossbarError({
        status: 401,
        code: "authentication",
        message: "Missing or invalid API key. Pass it as `Authorization: Bearer <key>`.",
        retryable: false,
      });
    }

    c.set("keyId", keyIds.get(token) ?? keyIdFor(token));
    // A key in both lists gets the broader tier; the free list is a floor.
    c.set("tier", isFull ? "full" : "free");
    return next();
  };
}
