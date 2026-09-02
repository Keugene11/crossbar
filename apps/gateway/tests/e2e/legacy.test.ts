import { afterEach, describe, expect, it } from "vitest";
import { createHarness, readSse, type Harness } from "../helpers.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function postCompletion(app: Harness["app"], body: unknown, headers: Record<string, string> = {}) {
  return app.request("/v1/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("legacy /v1/completions", () => {
  it("returns the text_completion shape", async () => {
    harness = await createHarness();

    const res = await postCompletion(harness.app, {
      model: "test/dual",
      prompt: "say hello",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.object).toBe("text_completion");
    expect(body.choices[0].text).toBe("Hello, world");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.choices[0]).not.toHaveProperty("message");
    expect(body.usage.completion_tokens).toBe(7);
  });

  it("sends the prompt upstream as a single user message", async () => {
    harness = await createHarness();
    await postCompletion(harness.app, { model: "test/dual", prompt: "say hello" });

    const sent = harness.anthropic.received[0]!.body as any;
    expect(sent.messages).toEqual([{ role: "user", content: [{ type: "text", text: "say hello" }] }]);
  });

  it("reuses the chat pipeline, so routing and the ledger behave identically", async () => {
    // The point of the shim: no second copy of routing or accounting to drift.
    harness = await createHarness({
      anthropic: { scripts: { "cheap-anthropic": "500" } },
      openai: { scripts: { "pricey-openai": "ok" } },
    });

    const res = await postCompletion(harness.app, { model: "test/dual", prompt: "hi" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-crossbar-provider")).toBe("openai");

    const id = res.headers.get("x-crossbar-generation-id")!;
    const gen = await harness.app.request(`/v1/generation?id=${id}`);
    expect(((await gen.json()) as any).data.attempts).toHaveLength(2);
  });

  it("enforces auth and rate limits like every other route", async () => {
    harness = await createHarness({ apiKeys: ["sk-key"] });
    expect((await postCompletion(harness.app, { model: "test/dual", prompt: "hi" })).status).toBe(401);

    const ok = await postCompletion(
      harness.app,
      { model: "test/dual", prompt: "hi" },
      { authorization: "Bearer sk-key" },
    );
    expect(ok.status).toBe(200);
  });

  it("passes a streamed body through untouched rather than rewriting SSE", async () => {
    harness = await createHarness();
    const res = await postCompletion(harness.app, {
      model: "test/dual",
      prompt: "hi",
      stream: true,
    });

    expect(res.status).toBe(200);
    const events = await readSse(res);
    expect(events.at(-1)).toBe("[DONE]");
  });

  it("surfaces an upstream failure with its real status, not a 500", async () => {
    // Re-entering through the sub-app used to rethrow instead of returning a
    // Response, turning a clean provider 401 into an opaque 500.
    harness = await createHarness({ anthropic: { script: "401" }, openai: { script: "401" } });

    const res = await postCompletion(harness.app, { model: "test/dual", prompt: "hi" });
    expect(res.status).toBe(401);

    const body = (await res.json()) as any;
    expect(body.error.code).toBe("all_providers_failed");
    expect(body.error.metadata.attempts.length).toBeGreaterThan(0);
  });

  it("propagates a 502 when every provider is down", async () => {
    harness = await createHarness({ anthropic: { script: "500" }, openai: { script: "500" } });
    const res = await postCompletion(harness.app, { model: "test/dual", prompt: "hi" });
    expect(res.status).toBe(502);
  });

  it("rejects an unknown field", async () => {
    harness = await createHarness();
    const res = await postCompletion(harness.app, {
      model: "test/dual",
      prompt: "hi",
      nonsense: 1,
    });
    expect(res.status).toBe(400);
  });
});

describe("/v1/activity", () => {
  it("rolls usage up by day, model, and provider", async () => {
    harness = await createHarness();

    await harness.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test/dual", messages: [{ role: "user", content: "hi" }] }),
    });

    const res = await harness.app.request("/v1/activity");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      model: "test/dual",
      provider_name: "anthropic",
      requests: 1,
      errors: 0,
      completion_tokens: 7,
    });
    expect(body.data[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.data[0].usage).toBeGreaterThan(0);
  });

  it("counts failures rather than hiding them", async () => {
    // A day that cost nothing because everything failed must not read as quiet.
    harness = await createHarness({ anthropic: { script: "500" }, openai: { script: "500" } });

    await harness.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test/dual", messages: [{ role: "user", content: "hi" }] }),
    });

    const body = (await (await harness.app.request("/v1/activity")).json()) as any;
    expect(body.data[0].errors).toBe(1);
    expect(body.data[0].usage).toBe(0);
  });

  it("is scoped to the calling key", async () => {
    harness = await createHarness({ apiKeys: ["sk-alice", "sk-bob"] });

    await harness.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-alice" },
      body: JSON.stringify({ model: "test/dual", messages: [{ role: "user", content: "hi" }] }),
    });

    const bob = await harness.app.request("/v1/activity", {
      headers: { authorization: "Bearer sk-bob" },
    });
    expect(((await bob.json()) as any).data).toHaveLength(0);
  });

  it("validates the days window", async () => {
    harness = await createHarness();
    for (const days of ["0", "91", "abc", "-1"]) {
      const res = await harness.app.request(`/v1/activity?days=${days}`);
      expect(res.status, `days=${days}`).toBe(400);
    }
    expect((await harness.app.request("/v1/activity?days=7")).status).toBe(200);
  });
});
