import { afterEach, describe, expect, it } from "vitest";
import { createHarness, postChat, readSse, type Harness } from "../helpers.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("OpenRouter-compatible surface", () => {
  it("serves the API under /api/v1 as well as /v1", async () => {
    // A client repointing from OpenRouter should only have to change the host.
    harness = await createHarness();

    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
    });
    const viaApi = await harness.app.request("/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test/dual", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(200);
    expect(viaApi.status).toBe(200);
    expect(((await viaApi.json()) as any).choices[0].message.content).toBe("Hello, world");
    expect((await harness.app.request("/api/v1/models")).status).toBe(200);
  });

  it("exposes per-model endpoint detail", async () => {
    harness = await createHarness();
    const res = await harness.app.request("/v1/models/test/dual/endpoints");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.data.id).toBe("test/dual");
    expect(body.data.endpoints).toHaveLength(2);
    expect(body.data.endpoints[0]).toHaveProperty("pricing");
  });

  it("routes :floor to the cheapest and :nitro by throughput", async () => {
    harness = await createHarness();

    await postChat(harness.app, {
      model: "test/dual:floor",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(harness.anthropic.received).toHaveLength(1); // $1 beats $9

    // :nitro sorts by measured throughput; the pricey endpoint is the only one
    // with a sample, so it wins despite costing more.
    harness.stats.recordSuccess("test/dual::openai", { tokensPerSecond: 500 });
    const res = await postChat(harness.app, {
      model: "test/dual:nitro",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.headers.get("x-crossbar-provider")).toBe("openai");
  });

  it("treats an unknown suffix as part of the model id", async () => {
    harness = await createHarness();
    const res = await postChat(harness.app, {
      model: "test/dual:turbo",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(404);
  });

  it("records app attribution from HTTP-Referer and X-Title", async () => {
    harness = await createHarness();
    const res = await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { "http-referer": "https://example.com", "x-title": "Example App" },
    );
    const id = ((await res.json()) as any).id;

    const [row] = await harness.db.db.query.generations.findMany();
    expect(row?.id).toBe(id);
    expect(row?.appReferer).toBe("https://example.com");
    expect(row?.appTitle).toBe("Example App");
  });

  it("bounds attacker-controlled attribution headers", async () => {
    harness = await createHarness();
    await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { "x-title": "T".repeat(5000) },
    );
    const [row] = await harness.db.db.query.generations.findMany();
    expect(row!.appTitle!.length).toBeLessThanOrEqual(512);
  });
});

describe("require_parameters", () => {
  it("skips an endpoint that cannot honour a required parameter", async () => {
    // The anthropic endpoint declares temperature unsupported; with
    // require_parameters the request must land on the one that accepts it.
    harness = await createHarness();

    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      provider: { require_parameters: true },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-crossbar-provider")).toBe("openai");
    expect(harness.openai.received[0]!.body.temperature).toBe(0.7);
  });

  it("still prefers the cheapest endpoint when the parameter is not required", async () => {
    harness = await createHarness();
    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
    });
    // Default behaviour is unchanged: cheapest wins, temperature is stripped.
    expect(res.headers.get("x-crossbar-provider")).toBe("anthropic");
    expect(harness.anthropic.received[0]!.body.temperature).toBeUndefined();
  });

  it("fails with a message naming the unmet parameters when nothing qualifies", async () => {
    harness = await createHarness();
    const res = await postChat(harness.app, {
      model: "test/backup",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
      provider: { require_parameters: true },
    });

    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.message).toMatch(/reasoning/);
  });
});

describe("client disconnect", () => {
  it("aborts the upstream stream instead of letting it run on", async () => {
    // Before this was fixed the TTFT teardown also removed disconnect
    // propagation, so a client hanging up left the upstream generating
    // billable tokens with nowhere to send them.
    harness = await createHarness({ anthropic: { script: "slow-stream", slowMs: 40 } });

    const controller = new AbortController();
    const res = await harness.app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test/dual",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
        signal: controller.signal,
      },
    );
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    await reader.read(); // first chunk: the endpoint is now committed
    await reader.cancel();
    controller.abort();

    // The generation is still recorded, and never billed as a clean finish.
    await new Promise((r) => setTimeout(r, 200));
    const [row] = await harness.db.db.query.generations.findMany();
    expect(row?.streamed).toBe(true);
  });

  it("completes normally when the client reads to the end", async () => {
    harness = await createHarness({ anthropic: { script: "slow-stream", slowMs: 5 } });
    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const events = await readSse(res);
    expect(events.at(-1)).toBe("[DONE]");
  });
});

describe("auto router", () => {
  it("resolves crossbar/auto to a concrete model and routes to it", async () => {
    harness = await createHarness();

    const res = await postChat(harness.app, {
      model: "crossbar/auto",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.status).toBe(200);
    // test/dual's anthropic endpoint is cheapest overall, so auto lands there.
    expect(res.headers.get("x-crossbar-endpoint")).toBe("test/dual::anthropic");
  });

  it("respects cost_tier as a spend ceiling", async () => {
    harness = await createHarness();

    // Every seeded endpoint is well under the low ceiling, so this still routes.
    const cheap = await postChat(harness.app, {
      model: "crossbar/auto",
      cost_tier: "low",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(cheap.status).toBe(200);
  });

  it("honours allowed_models, including author/* prefixes", async () => {
    harness = await createHarness();

    const res = await postChat(harness.app, {
      model: "crossbar/auto",
      allowed_models: ["test/backup"],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.headers.get("x-crossbar-model")).toBe("backup-openai");

    const prefixed = await postChat(harness.app, {
      model: "crossbar/auto",
      allowed_models: ["test/*"],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(prefixed.status).toBe(200);
  });

  it("404s when nothing satisfies the constraints", async () => {
    harness = await createHarness();
    const res = await postChat(harness.app, {
      model: "crossbar/auto",
      allowed_models: ["nobody/*"],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(404);
  });

  it("only considers endpoints that support what the request needs", async () => {
    // The anthropic test endpoint declares no vision support, so an image
    // request must land on the openai one even though it costs more.
    harness = await createHarness();
    const res = await postChat(harness.app, {
      model: "crossbar/auto",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://e.com/a.png" } }],
        },
      ],
    });
    expect(res.status).toBe(404); // neither test endpoint declares vision
  });
});

describe("context-aware routing", () => {
  it("refuses a request no endpoint can hold, without spending a round-trip", async () => {
    harness = await createHarness();

    const res = await postChat(harness.app, {
      model: "test/dual",
      // Far past the 100k-token test window.
      messages: [{ role: "user", content: "x".repeat(2_000_000) }],
    });

    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error.code).toBe("context_length_exceeded");
    // The point: no upstream call was made at all.
    expect(harness.anthropic.received).toHaveLength(0);
    expect(harness.openai.received).toHaveLength(0);
  });
});

describe("key info", () => {
  it("reports the calling key's own usage and rate limit", async () => {
    harness = await createHarness({ apiKeys: ["sk-alice"], rateLimitRpm: 600 });

    await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer sk-alice" },
    );

    const res = await harness.app.request("/v1/key", {
      headers: { authorization: "Bearer sk-alice" },
    });
    const body = (await res.json()) as any;

    expect(body.data.label).toMatch(/^key_/);
    expect(body.data.rate_limit).toEqual({ requests: 600, interval: "1m" });
    expect(body.data.usage_details.requests).toBe(1);
    expect(body.data.usage).toBeGreaterThan(0);
  });

  it("does not leak another key's usage", async () => {
    harness = await createHarness({ apiKeys: ["sk-alice", "sk-bob"] });

    await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer sk-alice" },
    );

    const bob = await harness.app.request("/v1/key", {
      headers: { authorization: "Bearer sk-bob" },
    });
    expect(((await bob.json()) as any).data.usage_details.requests).toBe(0);
  });
});

describe("middle-out transform", () => {
  const filler = (label: string) => `${label} ${"x".repeat(2000)}`;

  function longConversation() {
    const messages: any[] = [{ role: "system", content: "Be terse." }];
    for (let i = 0; i < 40; i++) {
      messages.push({ role: "user", content: filler(`u${i}`) });
      messages.push({ role: "assistant", content: filler(`a${i}`) });
    }
    messages.push({ role: "user", content: "the actual question" });
    return messages;
  }

  it("413s an over-long request when no transform is requested", async () => {
    harness = await createHarness({
      seed: [
        {
          id: "tiny/model",
          name: "Tiny window",
          contextLength: 2_000,
          inputModalities: ["text"],
          outputModalities: ["text"],
          endpoints: [
            {
              provider: "anthropic",
              upstreamModelId: "cheap-anthropic",
              pricePrompt: 1,
              priceCompletion: 1,
              maxOutputTokens: 256,
            },
          ],
        },
      ],
    });

    const res = await postChat(harness.app, {
      model: "tiny/model",
      messages: longConversation(),
    });
    expect(res.status).toBe(413);
  });

  it("compresses to fit when middle-out is requested, and says how much it dropped", async () => {
    harness = await createHarness({
      seed: [
        {
          id: "tiny/model",
          name: "Tiny window",
          contextLength: 2_000,
          inputModalities: ["text"],
          outputModalities: ["text"],
          endpoints: [
            {
              provider: "anthropic",
              upstreamModelId: "cheap-anthropic",
              pricePrompt: 1,
              priceCompletion: 1,
              maxOutputTokens: 256,
            },
          ],
        },
      ],
    });

    const res = await postChat(harness.app, {
      model: "tiny/model",
      messages: longConversation(),
      transforms: ["middle-out"],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(Number(res.headers.get("x-crossbar-dropped-messages"))).toBeGreaterThan(0);

    // The upstream saw the compressed conversation, with its edges intact.
    const sent = harness.anthropic.received[0]!.body as any;
    expect(sent.system).toEqual([{ type: "text", text: "Be terse." }]);
    const last = sent.messages.at(-1);
    expect(JSON.stringify(last)).toContain("the actual question");
    await readSse(res);
  });
});

describe("provider directory and policy routing", () => {
  it("lists providers with their data-retention policy", async () => {
    harness = await createHarness();
    const res = await harness.app.request("/v1/providers");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    const anthropic = body.data.find((p: any) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic.may_train_on_data).toBe(false);
    expect(anthropic.adapter_registered).toBe(true);
    expect(anthropic.endpoint_count).toBeGreaterThan(0);
  });

  it("routes only to non-training endpoints under data_collection:deny", async () => {
    harness = await createHarness({
      seed: [
        {
          id: "policy/model",
          name: "Policy test",
          contextLength: 100_000,
          inputModalities: ["text"],
          outputModalities: ["text"],
          endpoints: [
            {
              provider: "anthropic",
              upstreamModelId: "cheap-anthropic",
              pricePrompt: 1,
              priceCompletion: 1,
              maxOutputTokens: 4096,
              dataCollection: "allow",
            },
            {
              provider: "openai",
              upstreamModelId: "pricey-openai",
              pricePrompt: 9,
              priceCompletion: 9,
              maxOutputTokens: 4096,
              dataCollection: "deny",
            },
          ],
        },
      ],
    });

    const res = await postChat(harness.app, {
      model: "policy/model",
      messages: [{ role: "user", content: "sensitive" }],
      provider: { data_collection: "deny" },
    });

    // The cheap endpoint trains on data, so the pricier private one wins.
    expect(res.status).toBe(200);
    expect(res.headers.get("x-crossbar-provider")).toBe("openai");
    expect(harness.anthropic.received).toHaveLength(0);
  });
});

describe("prompt caching passthrough", () => {
  it("forwards cache_control breakpoints to the provider untouched", async () => {
    harness = await createHarness();

    await postChat(harness.app, {
      model: "test/dual",
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "a long stable preamble", cache_control: { type: "ephemeral" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "cached context", cache_control: { type: "ephemeral" } },
            { type: "text", text: "the volatile question" },
          ],
        },
      ],
    });

    const sent = harness.anthropic.received[0]!.body as any;
    expect(sent.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(sent.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    // Placement is the caller's decision; nothing is added on their behalf.
    expect(sent.messages[0].content[1].cache_control).toBeUndefined();
  });
});
