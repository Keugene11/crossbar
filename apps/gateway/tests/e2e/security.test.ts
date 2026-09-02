import { afterEach, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../../src/app.js";
import { LIMITS } from "../../src/schemas/openai.js";
import { MAX_ERROR_MESSAGE, truncate } from "../../src/errors.js";
import { MAX_ATTEMPTS_PER_REQUEST } from "../../src/routing/candidates.js";
import { createHarness, postChat, type Harness } from "../helpers.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("generation records are scoped to the owning key", () => {
  it("does not let one key read another key's generation", async () => {
    harness = await createHarness({ apiKeys: ["sk-alice", "sk-bob"] });

    const res = await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "alice's prompt" }] },
      { authorization: "Bearer sk-alice" },
    );
    const id = ((await res.json()) as any).id;

    // Ids travel in headers and logs; holding one must not be enough.
    const asBob = await harness.app.request(`/v1/generation?id=${id}`, {
      headers: { authorization: "Bearer sk-bob" },
    });
    expect(asBob.status).toBe(404);

    const asAlice = await harness.app.request(`/v1/generation?id=${id}`, {
      headers: { authorization: "Bearer sk-alice" },
    });
    expect(asAlice.status).toBe(200);
  });

  it("returns 404 rather than 403, so it does not confirm the id exists", async () => {
    harness = await createHarness({ apiKeys: ["sk-alice", "sk-bob"] });
    const res = await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer sk-alice" },
    );
    const id = ((await res.json()) as any).id;

    const real = await harness.app.request(`/v1/generation?id=${id}`, {
      headers: { authorization: "Bearer sk-bob" },
    });
    const fake = await harness.app.request("/v1/generation?id=gen_doesnotexist", {
      headers: { authorization: "Bearer sk-bob" },
    });
    expect(real.status).toBe(fake.status);
  });
});

describe("resource bounds", () => {
  it("rejects a body over the size limit", async () => {
    harness = await createHarness();
    const huge = "x".repeat(MAX_BODY_BYTES + 1024);
    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: huge }],
    });
    expect(res.status).toBe(413);
  });

  it("caps the model fallback chain", async () => {
    harness = await createHarness();
    const res = await postChat(harness.app, {
      model: "test/dual",
      models: Array.from({ length: LIMITS.fallbackModels + 5 }, () => "test/backup"),
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(400);
  });

  it("caps message count, tools, and stop sequences", async () => {
    harness = await createHarness();

    const tooManyMessages = await postChat(harness.app, {
      model: "test/dual",
      messages: Array.from({ length: LIMITS.messages + 1 }, () => ({
        role: "user" as const,
        content: "hi",
      })),
    });
    expect(tooManyMessages.status).toBe(400);

    const tooManyStops = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
      stop: Array.from({ length: LIMITS.stopSequences + 1 }, (_, i) => `s${i}`),
    });
    expect(tooManyStops.status).toBe(400);
  });

  it("never fans out past the attempt ceiling", async () => {
    // Even a maximal fallback chain must not become unbounded upstream calls.
    harness = await createHarness({ anthropic: { script: "500" }, openai: { script: "500" } });
    const res = await postChat(harness.app, {
      model: "test/dual",
      models: Array.from({ length: LIMITS.fallbackModels }, () => "test/backup"),
      messages: [{ role: "user", content: "hi" }],
    });

    const body = (await res.json()) as any;
    expect(body.error.metadata.attempts.length).toBeLessThanOrEqual(MAX_ATTEMPTS_PER_REQUEST);
  });

  it("truncates oversized upstream error text instead of echoing it whole", () => {
    const giant = "e".repeat(MAX_ERROR_MESSAGE * 4);
    const out = truncate(giant);
    expect(out.length).toBeLessThan(giant.length);
    expect(out).toMatch(/\[truncated\]$/);
    // Short messages are passed through untouched.
    expect(truncate("brief")).toBe("brief");
  });
});

describe("credential handling", () => {
  it("never echoes the bearer key back in any response", async () => {
    harness = await createHarness({ apiKeys: ["sk-supersecret"] });
    const res = await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer sk-supersecret" },
    );
    const text = await res.text();
    expect(text).not.toContain("sk-supersecret");
    expect(JSON.stringify([...res.headers])).not.toContain("sk-supersecret");
  });

  it("rejects a token that is a prefix, extension, or case variant of a valid key", async () => {
    harness = await createHarness({ apiKeys: ["sk-exact"] });
    for (const bad of ["sk-exac", "sk-exact2", "sk-Exact", "sk exact", "", "Bearer"]) {
      const res = await postChat(
        harness.app,
        { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
        { authorization: `Bearer ${bad}` },
      );
      expect(res.status, `token ${JSON.stringify(bad)} must not authenticate`).toBe(401);
    }
  });

  it("strips surrounding whitespace from the header, per RFC 7230", async () => {
    harness = await createHarness({ apiKeys: ["sk-exact"] });
    const res = await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer  sk-exact  " },
    );
    expect(res.status).toBe(200);
  });
});

describe("rate limiting", () => {
  it("throttles a caller past its burst and reports Retry-After", async () => {
    harness = await createHarness({ apiKeys: ["sk-alice"], rateLimitRpm: 60 });

    const send = () =>
      postChat(
        harness!.app,
        { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
        { authorization: "Bearer sk-alice" },
      );

    // Burst defaults to a quarter-minute of quota: 15 at 60/min.
    let throttled: Response | undefined;
    for (let i = 0; i < 40; i++) {
      const res = await send();
      if (res.status === 429) {
        throttled = res;
        break;
      }
    }

    expect(throttled).toBeDefined();
    expect(Number(throttled!.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(((await throttled!.json()) as any).error.code).toBe("rate_limited");
  });

  it("buckets each key separately, so one caller cannot starve another", async () => {
    harness = await createHarness({ apiKeys: ["sk-alice", "sk-bob"], rateLimitRpm: 60 });

    for (let i = 0; i < 40; i++) {
      const res = await postChat(
        harness.app,
        { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
        { authorization: "Bearer sk-alice" },
      );
      if (res.status === 429) break;
    }

    const bob = await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer sk-bob" },
    );
    expect(bob.status).toBe(200);
  });
});
