import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createDb } from "../../src/db/client.js";
import { seedCatalog } from "../../src/db/seed.js";
import { AnthropicAdapter } from "../../src/providers/anthropic/index.js";
import { OpenAIAdapter } from "../../src/providers/openai/index.js";
import { ProviderRegistry } from "../../src/providers/types.js";
import { Catalog } from "../../src/registry/catalog.js";
import { StatsTracker } from "../../src/routing/stats.js";
import { PostgresStore } from "../../src/store/postgres.js";
import { joinContent, postChat, readSse } from "../helpers.js";

/**
 * Smoke tests against the real provider APIs.
 *
 * Excluded from `pnpm test`; run with `pnpm test:live`. Deliberately tiny --
 * the cheapest model, a handful of output tokens -- because every run costs
 * real money. Everything else is covered by the fake upstream.
 */
const live = process.env.LIVE === "1";
const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);

async function liveApp() {
  const db = createDb({ url: ":memory:" });
  await db.migrate();
  await seedCatalog(db.db);

  const catalog = new Catalog(db.db, 60_000);
  await catalog.refresh();

  const providers = new ProviderRegistry()
    .register(new AnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }))
    .register(new OpenAIAdapter({ apiKey: process.env.OPENAI_API_KEY }));

  const app = createApp({
    db: db.db,
    store: new PostgresStore(db.db),
    catalog,
    providers,
    stats: new StatsTracker(),
    apiKeys: [],
    ttftTimeoutMs: 60_000,
    attemptTimeoutMs: 120_000,
  });
  return { app, close: () => db.close() };
}

describe.runIf(live)("live provider smoke tests", () => {
  it.runIf(hasAnthropic)("completes against Anthropic", { timeout: 120_000 }, async () => {
    const { app, close } = await liveApp();
    try {
      const res = await postChat(app, {
        model: "anthropic/claude-haiku-4-5",
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
        max_tokens: 16,
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, any>;
      expect(body.provider).toBe("anthropic");
      expect(body.choices[0].message.content).toMatch(/pong/i);
      expect(body.usage.prompt_tokens).toBeGreaterThan(0);
      expect(body.usage.cost).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it.runIf(hasAnthropic)("streams against Anthropic", { timeout: 120_000 }, async () => {
    const { app, close } = await liveApp();
    try {
      const res = await postChat(app, {
        model: "anthropic/claude-haiku-4-5",
        messages: [{ role: "user", content: "Count: 1 2 3" }],
        max_tokens: 32,
        stream: true,
        stream_options: { include_usage: true },
      });
      const events = await readSse(res);

      expect(joinContent(events).length).toBeGreaterThan(0);
      expect(events.at(-1)).toBe("[DONE]");
      expect(events.some((e) => e !== "[DONE]" && e.usage)).toBe(true);
    } finally {
      await close();
    }
  });

  it.runIf(hasOpenAI)("completes against OpenAI", { timeout: 120_000 }, async () => {
    const { app, close } = await liveApp();
    try {
      const res = await postChat(app, {
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
        max_tokens: 16,
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, any>;
      expect(body.provider).toBe("openai");
      expect(body.choices[0].message.content).toMatch(/pong/i);
    } finally {
      await close();
    }
  });
});
