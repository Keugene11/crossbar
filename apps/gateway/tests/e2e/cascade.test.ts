import { afterEach, describe, expect, it } from "vitest";
import { createHarness, joinContent, postChat, readSse, type Harness } from "../helpers.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const CHEAP = "cheap-anthropic"; // test/dual, $1  -- always tried first
const PRICEY = "pricey-openai"; // test/dual, $9  -- the in-model fallback
const BACKUP = "backup-openai"; // test/backup    -- the model-level fallback

describe("failover before the first chunk", () => {
  it("falls through a 429 to the next endpoint and records both attempts", async () => {
    harness = await createHarness({
      anthropic: { scripts: { [CHEAP]: "429" } },
      openai: { scripts: { [PRICEY]: "ok" } },
    });

    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.provider).toBe("openai");
    expect(body.choices[0].message.content).toBe("Hello, world");
    expect(res.headers.get("x-crossbar-provider")).toBe("openai");
    expect(res.headers.get("x-crossbar-attempts")).toBe("2");

    const gen = await harness.app.request(`/v1/generation?id=${body.id}`);
    const record = (await gen.json()) as Record<string, any>;
    expect(record.data.attempts).toHaveLength(2);
    expect(record.data.attempts[0]).toMatchObject({
      provider: "anthropic",
      error: { status: 429, code: "rate_limited" },
    });
    expect(record.data.attempts[1]).toMatchObject({ provider: "openai", error: null });
  });

  it("retries 500 and 529 as well", async () => {
    harness = await createHarness({ anthropic: { scripts: { [CHEAP]: "529" } } });
    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-crossbar-provider")).toBe("openai");
  });

  it("falls through to the model-level `models` chain once endpoints are exhausted", async () => {
    harness = await createHarness({
      anthropic: { scripts: { [CHEAP]: "500" } },
      openai: { scripts: { [PRICEY]: "500", [BACKUP]: "ok" } },
    });

    const res = await postChat(harness.app, {
      model: "test/dual",
      models: ["test/backup"],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-crossbar-model")).toBe(BACKUP);
    expect(res.headers.get("x-crossbar-attempts")).toBe("3");
  });

  it("returns 502 with the full attempt list when everything fails", async () => {
    harness = await createHarness({
      anthropic: { script: "500" },
      openai: { script: "500" },
    });

    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(502);

    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("all_providers_failed");
    expect(body.error.metadata.attempts).toHaveLength(2);
  });

  it("preserves a 429 through exhaustion so clients still back off", async () => {
    harness = await createHarness({ anthropic: { script: "429" }, openai: { script: "429" } });
    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(429);
  });
});

describe("terminal failures stop the cascade", () => {
  it("does not burn the chain on a non-retryable 400", async () => {
    harness = await createHarness({ anthropic: { scripts: { [CHEAP]: "400" } } });

    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.status).toBe(400);
    // A malformed request fails identically everywhere, so only one attempt --
    // and the failure is still traceable.
    expect(res.headers.get("x-crossbar-attempts")).toBe("1");
    expect(res.headers.get("x-crossbar-generation-id")).toMatch(/^gen_/);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.metadata.attempts).toHaveLength(1);
    expect(harness.openai.received).toHaveLength(0);
  });

  it("skips the provider on a 401 but still tries other providers", async () => {
    // Credentials are per-provider: a bad Anthropic key says nothing about the
    // OpenAI key, so one expired secret must not take down the whole request.
    harness = await createHarness({
      anthropic: { scripts: { [CHEAP]: "401" } },
      openai: { scripts: { [PRICEY]: "ok" } },
    });

    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-crossbar-provider")).toBe("openai");
    expect(harness.openai.received).toHaveLength(1);
  });

  it("surfaces 401 rather than 502 when every provider's credentials fail", async () => {
    harness = await createHarness({ anthropic: { script: "401" }, openai: { script: "401" } });
    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
    });
    // A 502 would send the operator hunting for an outage that isn't there.
    expect(res.status).toBe(401);
  });

  it("allow_fallbacks:false attempts exactly one endpoint", async () => {
    harness = await createHarness({ anthropic: { scripts: { [CHEAP]: "500" } } });

    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
      provider: { allow_fallbacks: false },
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.metadata.attempts).toHaveLength(1);
    expect(harness.openai.received).toHaveLength(0);
  });
});

describe("failure after the first chunk is terminal", () => {
  it("emits an error frame in the open stream and never tries another provider", async () => {
    harness = await createHarness({
      anthropic: { scripts: { [CHEAP]: "fail-after-first-chunk" } },
      openai: { scripts: { [PRICEY]: "ok" } },
    });

    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });

    // The status line went out with the first chunk, so it is still 200.
    expect(res.status).toBe(200);
    expect(res.headers.get("x-crossbar-provider")).toBe("anthropic");

    const events = await readSse(res);
    expect(events.at(-1)).toBe("[DONE]");

    const errorFrame = events.find((e) => e !== "[DONE]" && "error" in e) as
      | Record<string, any>
      | undefined;
    expect(errorFrame).toBeDefined();
    expect(errorFrame?.error.message).toMatch(/mid-stream|reset|terminated|closed/i);

    // The whole point: no failover once bytes are committed.
    expect(harness.openai.received).toHaveLength(0);
  });

  it("still records the partial generation, marked as an error", async () => {
    harness = await createHarness({
      anthropic: { scripts: { [CHEAP]: "fail-after-first-chunk" } },
    });

    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    await readSse(res);

    const id = res.headers.get("x-crossbar-generation-id")!;
    const gen = await harness.app.request(`/v1/generation?id=${id}`);
    const record = (await gen.json()) as Record<string, any>;

    expect(record.data.finish_reason).toBe("error");
    expect(record.data.error).not.toBeNull();
    expect(record.data.total_cost).toBe(0);
  });
});

describe("failover while streaming", () => {
  it("fails over cleanly when the first endpoint dies before any chunk", async () => {
    harness = await createHarness({
      anthropic: { scripts: { [CHEAP]: "500" } },
      openai: { scripts: { [PRICEY]: "ok" } },
    });

    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });

    expect(res.headers.get("x-crossbar-provider")).toBe("openai");
    const events = await readSse(res);
    expect(joinContent(events)).toBe("Hello, world");
    expect(events.at(-1)).toBe("[DONE]");
  });
});

describe("health feedback", () => {
  it("deprioritises an endpoint that just failed on the next request", async () => {
    harness = await createHarness({
      anthropic: { scripts: { [CHEAP]: "500" } },
      openai: { scripts: { [PRICEY]: "ok" } },
    });

    await postChat(harness.app, { model: "test/dual", messages: [{ role: "user", content: "1" }] });
    expect(harness.stats.get("test/dual::anthropic").recentOutage).toBe(true);

    // Second request should now go straight to the healthy (pricier) endpoint.
    harness.openai.received.length = 0;
    harness.anthropic.received.length = 0;
    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "2" }],
    });

    expect(res.headers.get("x-crossbar-provider")).toBe("openai");
    expect(res.headers.get("x-crossbar-attempts")).toBe("1");
    expect(harness.anthropic.received).toHaveLength(0);
  });
});
