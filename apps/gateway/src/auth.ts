import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { CrossbarError } from "./errors.js";
import { isExhausted, remainingMicro, type KeyStore } from "./keys/store.js";

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
  /** Credit remaining in micro-USD; null when the key is unlimited. */
  creditMicro?: number | null;
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
export interface AuthOptions {
  /** Operator keys from configuration. Unlimited, never metered. */
  apiKeys: string[];
  /** Configured keys confined to zero-cost endpoints. */
  freeApiKeys?: string[];
  /** Issued keys with credit balances, when a key store is available. */
  keys?: KeyStore | undefined;
}

/**
 * Two sources of truth, on purpose.
 *
 * Keys in configuration belong to whoever runs the gateway: unlimited, no
 * balance, always valid. Issued keys come from the store and carry credit, so
 * an operator can hand crossbar to other people without handing over the
 * provider credentials -- which is the entire reason the product exists.
 */
export function auth(opts: AuthOptions): MiddlewareHandler<{ Variables: AuthVariables }> {
  const { apiKeys, freeApiKeys = [], keys } = opts;
  const allowed = apiKeys.map(digest);
  const free = freeApiKeys.map(digest);
  const keyIds = new Map([...apiKeys, ...freeApiKeys].map((k) => [k, keyIdFor(k)]));
  // Auth is on exactly when keys are configured. The issued-key store only
  // ever *adds* valid keys -- its presence must not silently lock a local dev
  // gateway that was deliberately left open.
  const authDisabled = apiKeys.length === 0 && freeApiKeys.length === 0;

  return async (c, next) => {
    if (authDisabled) {
      c.set("keyId", null);
      c.set("tier", "full");
      c.set("creditMicro", null);
      return next();
    }

    const token = bearerToken(c.req.header("authorization"));
    const isFree = Boolean(token) && constantTimeIncludes(token!, free);
    const isFull = Boolean(token) && constantTimeIncludes(token!, allowed);

    if (token && (isFree || isFull)) {
      c.set("keyId", keyIds.get(token) ?? keyIdFor(token));
      // A key in both lists gets the broader tier; the free list is a floor.
      c.set("tier", isFull ? "full" : "free");
      c.set("creditMicro", null);
      return next();
    }

    const issued = token && keys ? await keys.find(token) : undefined;
    if (issued && !issued.disabled) {
      if (isExhausted(issued)) {
        throw new CrossbarError({
          status: 402,
          code: "permission",
          message: "This key is out of credit. Top it up to keep using paid models.",
          retryable: false,
        });
      }
      c.set("keyId", issued.id);
      c.set("tier", "full");
      c.set("creditMicro", remainingMicro(issued));
      return next();
    }

    throw new CrossbarError({
      status: 401,
      code: "authentication",
      message: "Missing or invalid API key. Pass it as `Authorization: Bearer <key>`.",
      retryable: false,
    });
  };
}
