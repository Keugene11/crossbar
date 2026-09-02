import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../../src/db/client.js";
import type { NewGeneration } from "../../src/db/schema.js";
import { MemoryStore } from "../../src/store/memory.js";
import { PostgresStore } from "../../src/store/postgres.js";
import type { GenerationStore } from "../../src/store/types.js";

/**
 * Both stores are held to one contract.
 *
 * The whole point of the abstraction is that a stateless deployment behaves
 * like a durable one until the process ends, so every assertion here runs
 * twice -- against Postgres and against memory.
 */
function gen(over: Partial<NewGeneration> = {}): NewGeneration {
  return {
    id: `gen_${Math.random().toString(16).slice(2)}`,
    keyId: null,
    appReferer: null,
    appTitle: null,
    createdAt: new Date(),
    requestedModel: "a/b",
    modelId: "a/b",
    endpointId: "a/b::p",
    provider: "p",
    streamed: false,
    finishReason: "stop",
    promptTokens: 100,
    completionTokens: 50,
    reasoningTokens: 0,
    cachedTokens: 10,
    costMicro: 1_000,
    latencyMs: 20,
    ttftMs: 10,
    attempts: [],
    error: null,
    ...over,
  };
}

interface Target {
  name: string;
  make(): Promise<{ store: GenerationStore; close(): Promise<void> }>;
}

const targets: Target[] = [
  {
    name: "memory",
    make: async () => ({ store: new MemoryStore(), close: async () => {} }),
  },
  {
    name: "postgres",
    make: async () => {
      const db: DbHandle = createDb({ url: ":memory:" });
      await db.migrate();
      return { store: new PostgresStore(db.db), close: () => db.close() };
    },
  },
];

for (const target of targets) {
  describe(`GenerationStore contract: ${target.name}`, () => {
    let store: GenerationStore;
    let close: () => Promise<void>;

    beforeEach(async () => {
      ({ store, close } = await target.make());
    });
    afterEach(async () => close());

    it("records and reads back a generation", async () => {
      const row = gen({ id: "gen_1" });
      await store.record(row);

      const found = await store.get("gen_1", null);
      expect(found?.id).toBe("gen_1");
      expect(found?.promptTokens).toBe(100);
      expect(found?.costMicro).toBe(1_000);
    });

    it("scopes reads to the owning key", async () => {
      await store.record(gen({ id: "gen_a", keyId: "key_alice" }));

      expect(await store.get("gen_a", "key_alice")).toBeDefined();
      // A leaked id is not authorisation, in either store.
      expect(await store.get("gen_a", "key_bob")).toBeUndefined();
      // A null key means auth is off, so everything matches.
      expect(await store.get("gen_a", null)).toBeDefined();
    });

    it("returns undefined for an unknown id", async () => {
      expect(await store.get("gen_missing", null)).toBeUndefined();
    });

    it("aggregates usage for one key only", async () => {
      await store.record(gen({ keyId: "key_alice", costMicro: 100, completionTokens: 5 }));
      await store.record(gen({ keyId: "key_alice", costMicro: 250, completionTokens: 7 }));
      await store.record(gen({ keyId: "key_bob", costMicro: 999, completionTokens: 9 }));

      const alice = await store.usage("key_alice");
      expect(alice.requests).toBe(2);
      expect(alice.costMicro).toBe(350);
      expect(alice.completionTokens).toBe(12);

      expect((await store.usage("key_bob")).requests).toBe(1);
      expect((await store.usage(null)).requests).toBe(3);
    });

    it("reports zeroes rather than throwing when a key has no history", async () => {
      expect(await store.usage("key_nobody")).toMatchObject({ requests: 0, costMicro: 0 });
    });

    it("rolls activity up by day, model, and provider", async () => {
      await store.record(gen({ requestedModel: "a/b", provider: "p", costMicro: 10 }));
      await store.record(gen({ requestedModel: "a/b", provider: "p", costMicro: 20 }));
      await store.record(gen({ requestedModel: "c/d", provider: "q", costMicro: 30 }));

      const rows = await store.activity(null, new Date(Date.now() - 86_400_000));
      expect(rows).toHaveLength(2);

      const ab = rows.find((r) => r.model === "a/b");
      expect(ab?.requests).toBe(2);
      expect(ab?.costMicro).toBe(30);
      expect(ab?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("counts errors in the activity rollup", async () => {
      await store.record(gen({ error: { code: "provider_error", status: 502, message: "x" } }));
      await store.record(gen({ error: null }));

      const [row] = await store.activity(null, new Date(Date.now() - 86_400_000));
      expect(row?.requests).toBe(2);
      expect(row?.errors).toBe(1);
    });

    it("excludes rows older than the window", async () => {
      const old = new Date(Date.now() - 10 * 86_400_000);
      await store.record(gen({ createdAt: old }));
      await store.record(gen({ createdAt: new Date() }));

      const rows = await store.activity(null, new Date(Date.now() - 86_400_000));
      expect(rows.reduce((n, r) => n + r.requests, 0)).toBe(1);
    });

    it("answers a readiness probe", async () => {
      expect(await store.ping()).toBe(true);
    });
  });
}

describe("memory store bounds", () => {
  it("evicts the oldest generations rather than growing without limit", async () => {
    // An unbounded ring in a long-lived process is a slow memory leak.
    const store = new MemoryStore(3);
    for (const id of ["a", "b", "c", "d"]) await store.record(gen({ id }));

    expect(await store.get("a", null)).toBeUndefined();
    expect(await store.get("d", null)).toBeDefined();
    expect((await store.usage(null)).requests).toBe(3);
  });

  it("declares itself non-durable", () => {
    expect(new MemoryStore().durable).toBe(false);
    expect(new MemoryStore().kind).toBe("memory");
  });
});
