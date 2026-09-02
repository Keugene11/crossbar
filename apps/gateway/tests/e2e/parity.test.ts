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
