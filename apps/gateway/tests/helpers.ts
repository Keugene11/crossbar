import { createApp, type App } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/client.js";
import { seedCatalog } from "../src/db/seed.js";
import { AnthropicAdapter } from "../src/providers/anthropic/index.js";
import { OpenAIAdapter } from "../src/providers/openai/index.js";
import { ProviderRegistry } from "../src/providers/types.js";
import { Catalog, type Endpoint } from "../src/registry/catalog.js";
import type { SeedModel } from "../src/registry/seed.js";
import { StatsTracker } from "../src/routing/stats.js";
import { createFakeUpstream, type FakeUpstream, type FakeUpstreamOptions } from "./fake-upstream/index.js";

/**
 * Two providers, two endpoints each, with prices chosen to make routing
 * decisions unambiguous in assertions.
 */
export const TEST_CATALOG: SeedModel[] = [
  {
    id: "test/dual",
    name: "Test: dual-endpoint model",
    contextLength: 100_000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    endpoints: [
      {
        provider: "anthropic",
        upstreamModelId: "cheap-anthropic",
        pricePrompt: 1,
        priceCompletion: 1,
        priceCacheRead: 0.1,
        maxOutputTokens: 4096,
        supportsReasoning: true,
        unsupportedParams: ["temperature", "top_p", "top_k"],
      },
      {
        provider: "openai",
        upstreamModelId: "pricey-openai",
        pricePrompt: 9,
        priceCompletion: 9,
        priceCacheRead: 0.9,
        maxOutputTokens: 4096,
      },
    ],
  },
  {
    id: "test/backup",
    name: "Test: model-level fallback target",
    contextLength: 100_000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    endpoints: [
      {
        provider: "openai",
        upstreamModelId: "backup-openai",
        pricePrompt: 2,
        priceCompletion: 2,
        maxOutputTokens: 4096,
      },
    ],
  },
];

export interface Harness {
  app: App;
  db: DbHandle;
  catalog: Catalog;
  stats: StatsTracker;
  anthropic: FakeUpstream;
  openai: FakeUpstream;
  endpoint(id: string): Endpoint;
  close(): Promise<void>;
}

export interface HarnessOptions {
  seed?: SeedModel[];
  anthropic?: FakeUpstreamOptions;
  openai?: FakeUpstreamOptions;
  apiKeys?: string[];
  /** Defaults to a fixed value so price-weighted ordering is reproducible. */
  random?: () => number;
  ttftTimeoutMs?: number;
  attemptTimeoutMs?: number;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const db = createDb({ url: ":memory:" });
  await db.migrate();
  await seedCatalog(db.db, opts.seed ?? TEST_CATALOG);

  const catalog = new Catalog(db.db, 60_000);
  await catalog.refresh();

  const anthropic = createFakeUpstream(opts.anthropic);
  const openai = createFakeUpstream(opts.openai);

  const providers = new ProviderRegistry()
    .register(
      new AnthropicAdapter({
        apiKey: "test",
        baseUrl: "http://anthropic.fake",
        fetch: anthropic.fetch as typeof globalThis.fetch,
      }),
    )
    .register(
      new OpenAIAdapter({
        apiKey: "test",
        baseUrl: "http://openai.fake/v1",
        fetch: openai.fetch as typeof globalThis.fetch,
      }),
    );

  const stats = new StatsTracker();

  const app = createApp({
    db: db.db,
    catalog,
    providers,
    stats,
    apiKeys: opts.apiKeys ?? [],
    ttftTimeoutMs: opts.ttftTimeoutMs ?? 5_000,
    attemptTimeoutMs: opts.attemptTimeoutMs ?? 5_000,
    // Always draw the first item of the weighted pool unless a test says otherwise.
    random: opts.random ?? (() => 0),
  });

  return {
    app,
    db,
    catalog,
    stats,
    anthropic,
    openai,
    endpoint(id: string): Endpoint {
      const e = catalog.getEndpoint(id);
      if (!e) throw new Error(`test harness: no endpoint "${id}"`);
      return e;
    },
    close: () => db.close(),
  };
}

export async function postChat(app: App, body: unknown, headers: Record<string, string> = {}) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Parse an SSE body into its `data:` payloads, with `[DONE]` kept as a marker. */
export async function readSse(res: Response): Promise<Array<Record<string, unknown> | "[DONE]">> {
  const text = await res.text();
  const out: Array<Record<string, unknown> | "[DONE]"> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") out.push("[DONE]");
    else out.push(JSON.parse(payload) as Record<string, unknown>);
  }
  return out;
}

/** Concatenate the assistant text across streamed chunks. */
export function joinContent(events: Array<Record<string, unknown> | "[DONE]">): string {
  let text = "";
  for (const e of events) {
    if (e === "[DONE]") continue;
    const choices = e.choices as Array<{ delta?: { content?: string | null } }> | undefined;
    text += choices?.[0]?.delta?.content ?? "";
  }
  return text;
}
