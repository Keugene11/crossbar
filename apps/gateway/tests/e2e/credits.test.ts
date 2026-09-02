import { afterEach, describe, expect, it } from "vitest";
import { createHarness, postChat, type Harness } from "../helpers.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const OPERATOR = "sk-operator";

/** Everything a tenant needs: a key with credit on it, and no provider account. */
async function issue(h: Harness, credit: number | null, label = "test app") {
  const res = await h.app.request("/v1/keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPERATOR}` },
    body: JSON.stringify({ label, credit }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { data: { key: string; id: string; limit: number | null } };
}

describe("issuing keys", () => {
  it("hands out a key with credit, and returns it exactly once", async () => {
    harness = await createHarness({ apiKeys: [OPERATOR] });
    const { data } = await issue(harness, 5);

    expect(data.key).toMatch(/^sk-crossbar-/);
    expect(data.limit).toBe(5);
    expect(data.id).toMatch(/^key_[0-9a-f]{16}$/);

    // The listing never exposes the key again -- only its hash is stored.
    const list = (await (
      await harness.app.request("/v1/keys", { headers: { authorization: `Bearer ${OPERATOR}` } })
    ).json()) as any;
    expect(JSON.stringify(list)).not.toContain(data.key);
    expect(list.data[0].id).toBe(data.id);
  });

  it("lets an issued key call models with no provider account of its own", async () => {
    // This is the whole product: the operator holds the provider credentials,
    // the tenant holds a key with credit.
    harness = await createHarness({ apiKeys: [OPERATOR] });
    const { data } = await issue(harness, 5);

    const res = await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { authorization: `Bearer ${data.key}` },
    );
    expect(res.status).toBe(200);
  });

  it("rejects an unknown or revoked key", async () => {
    harness = await createHarness({ apiKeys: [OPERATOR] });
    const { data } = await issue(harness, 5);

    expect(
      (await postChat(harness.app, { model: "test/dual", messages: [{ role: "user", content: "x" }] }, { authorization: "Bearer sk-crossbar-nope" })).status,
    ).toBe(401);

    await harness.app.request(`/v1/keys/${data.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${OPERATOR}` },
    });

    expect(
      (await postChat(harness.app, { model: "test/dual", messages: [{ role: "user", content: "x" }] }, { authorization: `Bearer ${data.key}` })).status,
    ).toBe(401);
  });
});

describe("spending credit", () => {
  it("debits what the generation actually cost", async () => {
    harness = await createHarness({ apiKeys: [OPERATOR] });
    const { data } = await issue(harness, 5);

    await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { authorization: `Bearer ${data.key}` },
    );

    const credits = (await (
      await harness.app.request("/v1/credits", { headers: { authorization: `Bearer ${data.key}` } })
    ).json()) as any;

    expect(credits.data.total_usage).toBeGreaterThan(0);
    expect(credits.data.limit_remaining).toBeLessThan(5);
    // Balance and ledger must agree: both derive from the recorded cost.
    expect(credits.data.limit_remaining).toBeCloseTo(5 - credits.data.total_usage, 9);
  });

  it("refuses a key that has run out", async () => {
    // A key granted nothing cannot spend anything.
    harness = await createHarness({ apiKeys: [OPERATOR] });
    const { data } = await issue(harness, 0);

    const res = await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { authorization: `Bearer ${data.key}` },
    );
    expect(res.status).toBe(402);
    expect(((await res.json()) as any).error.message).toMatch(/out of credit/i);
  });

  it("does not charge for a failed generation", async () => {
    harness = await createHarness({
      apiKeys: [OPERATOR],
      anthropic: { script: "500" },
      openai: { script: "500" },
    });
    const { data } = await issue(harness, 5);

    await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { authorization: `Bearer ${data.key}` },
    );

    const credits = (await (
      await harness.app.request("/v1/credits", { headers: { authorization: `Bearer ${data.key}` } })
    ).json()) as any;
    expect(credits.data.total_usage).toBe(0);
    expect(credits.data.limit_remaining).toBe(5);
  });

  it("an unlimited key reports no ceiling", async () => {
    harness = await createHarness({ apiKeys: [OPERATOR] });
    const { data } = await issue(harness, null);

    const credits = (await (
      await harness.app.request("/v1/credits", { headers: { authorization: `Bearer ${data.key}` } })
    ).json()) as any;
    expect(credits.data.limit_remaining).toBeNull();
  });
});

describe("key management is operator-only", () => {
  it("an issued key cannot mint itself more credit", async () => {
    // Otherwise the balance would be advisory rather than a limit.
    harness = await createHarness({ apiKeys: [OPERATOR] });
    const { data } = await issue(harness, 5);

    for (const [method, path] of [
      ["POST", "/v1/keys"],
      ["GET", "/v1/keys"],
      ["DELETE", `/v1/keys/${data.id}`],
    ] as const) {
      const res = await harness.app.request(path, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${data.key}` },
        ...(method === "POST" ? { body: JSON.stringify({ credit: 1000 }) } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });
});

describe("topping up", () => {
  it("adds credit to a key that has run down", async () => {
    // A balance is a running account, not a number fixed at issue time.
    harness = await createHarness({ apiKeys: [OPERATOR] });
    const { data } = await issue(harness, 0);

    const blocked = await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { authorization: `Bearer ${data.key}` },
    );
    expect(blocked.status).toBe(402);

    const top = await harness.app.request(`/v1/keys/${data.id}/credit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${OPERATOR}` },
      body: JSON.stringify({ amount: 3 }),
    });
    expect(top.status).toBe(200);
    expect(((await top.json()) as any).data.limit).toBe(3);

    const ok = await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { authorization: `Bearer ${data.key}` },
    );
    expect(ok.status).toBe(200);
  });

  it("accumulates rather than replacing", async () => {
    harness = await createHarness({ apiKeys: [OPERATOR] });
    const { data } = await issue(harness, 2);

    for (const amount of [3, 5]) {
      await harness.app.request(`/v1/keys/${data.id}/credit`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${OPERATOR}` },
        body: JSON.stringify({ amount }),
      });
    }

    const credits = (await (
      await harness.app.request("/v1/credits", { headers: { authorization: `Bearer ${data.key}` } })
    ).json()) as any;
    expect(credits.data.limit_remaining).toBe(10);
  });

  it("cannot be reached by the key it would credit", async () => {
    harness = await createHarness({ apiKeys: [OPERATOR] });
    const { data } = await issue(harness, 1);

    const res = await harness.app.request(`/v1/keys/${data.id}/credit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${data.key}` },
      body: JSON.stringify({ amount: 9999 }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a nonsense amount", async () => {
    harness = await createHarness({ apiKeys: [OPERATOR] });
    const { data } = await issue(harness, 1);

    for (const body of [{ amount: 0 }, { amount: -5 }, {}]) {
      const res = await harness.app.request(`/v1/keys/${data.id}/credit`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${OPERATOR}` },
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});
