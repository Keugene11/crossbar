import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { apiKeys } from "../db/schema.js";

/**
 * Issued gateway keys and their balances.
 *
 * The point of the whole product lives here: the operator holds provider
 * credentials once, and hands out keys with credit on them. Someone using a
 * crossbar never needs an Anthropic or OpenAI account of their own.
 */

export interface IssuedKey {
  id: string;
  label: string | null;
  /** Null means unlimited -- an operator key. */
  creditMicro: number | null;
  spentMicro: number;
  disabled: boolean;
}

export interface KeyStore {
  readonly durable: boolean;
  /** Look a key up by its plaintext value. Undefined when unknown. */
  find(token: string): Promise<IssuedKey | undefined>;
  /** Add to the spend counter. Never throws into the request path. */
  debit(id: string, micro: number): Promise<void>;
  create(opts: { label?: string; creditMicro?: number | null }): Promise<{ key: string; issued: IssuedKey }>;
  list(): Promise<IssuedKey[]>;
  revoke(id: string): Promise<boolean>;
}

export function hashKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function keyIdFromHash(hash: string): string {
  return `key_${hash.slice(0, 16)}`;
}

/** A new key. Shown once; only its hash is ever stored. */
export function generateKey(): string {
  return `sk-crossbar-${randomBytes(24).toString("base64url")}`;
}

/** Credit remaining, or null when the key is unlimited. */
export function remainingMicro(k: IssuedKey): number | null {
  return k.creditMicro === null ? null : Math.max(k.creditMicro - k.spentMicro, 0);
}

export function isExhausted(k: IssuedKey): boolean {
  const left = remainingMicro(k);
  return left !== null && left <= 0;
}

export class PostgresKeyStore implements KeyStore {
  readonly durable = true;
  constructor(private readonly db: DB) {}

  async find(token: string): Promise<IssuedKey | undefined> {
    const [row] = await this.db.select().from(apiKeys).where(eq(apiKeys.hash, hashKey(token))).limit(1);
    return row ? toIssued(row) : undefined;
  }

  async debit(id: string, micro: number): Promise<void> {
    if (micro <= 0) return;
    // Incremented in SQL rather than read-modify-write, so concurrent requests
    // on one key cannot lose spend against each other.
    await this.db
      .update(apiKeys)
      .set({ spentMicro: sql`${apiKeys.spentMicro} + ${micro}`, lastUsedAt: new Date() })
      .where(eq(apiKeys.id, id));
  }

  async create(opts: { label?: string; creditMicro?: number | null } = {}): Promise<{ key: string; issued: IssuedKey }> {
    const key = generateKey();
    const hash = hashKey(key);
    const row = {
      id: keyIdFromHash(hash),
      hash,
      label: opts.label ?? null,
      creditMicro: opts.creditMicro === undefined ? 0 : opts.creditMicro,
      spentMicro: 0,
      disabled: false,
    };
    await this.db.insert(apiKeys).values(row);
    return { key, issued: toIssued(row) };
  }

  async list(): Promise<IssuedKey[]> {
    return (await this.db.select().from(apiKeys)).map(toIssued);
  }

  async revoke(id: string): Promise<boolean> {
    const rows = await this.db
      .update(apiKeys)
      .set({ disabled: true })
      .where(eq(apiKeys.id, id))
      .returning({ id: apiKeys.id });
    return rows.length > 0;
  }
}

function toIssued(row: {
  id: string;
  label: string | null;
  creditMicro: number | null;
  spentMicro: number;
  disabled: boolean;
}): IssuedKey {
  return {
    id: row.id,
    label: row.label,
    creditMicro: row.creditMicro,
    spentMicro: row.spentMicro,
    disabled: row.disabled,
  };
}

/** Non-durable equivalent, for deployments with no database. */
export class MemoryKeyStore implements KeyStore {
  readonly durable = false;
  readonly #byHash = new Map<string, IssuedKey & { hash: string }>();

  async find(token: string): Promise<IssuedKey | undefined> {
    return this.#byHash.get(hashKey(token));
  }

  async debit(id: string, micro: number): Promise<void> {
    if (micro <= 0) return;
    for (const k of this.#byHash.values()) {
      if (k.id === id) k.spentMicro += micro;
    }
  }

  async create(opts: { label?: string; creditMicro?: number | null } = {}): Promise<{ key: string; issued: IssuedKey }> {
    const key = generateKey();
    const hash = hashKey(key);
    const issued = {
      id: keyIdFromHash(hash),
      hash,
      label: opts.label ?? null,
      creditMicro: opts.creditMicro === undefined ? 0 : opts.creditMicro,
      spentMicro: 0,
      disabled: false,
    };
    this.#byHash.set(hash, issued);
    return { key, issued };
  }

  async list(): Promise<IssuedKey[]> {
    return [...this.#byHash.values()];
  }

  async revoke(id: string): Promise<boolean> {
    let found = false;
    for (const k of this.#byHash.values()) {
      if (k.id === id) {
        k.disabled = true;
        found = true;
      }
    }
    return found;
  }
}
