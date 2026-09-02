import { afterEach, describe, expect, it } from "vitest";
import { createHarness, joinContent, postChat, readSse, type Harness } from "../helpers.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const CHEAP = "cheap-anthropic";

describe("non-streaming completions", () => {
  it("returns an OpenAI-shaped body with routing headers", async () => {
    harness = await createHarness();

    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;

    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("test/dual");
    expect(body.provider).toBe("anthropic");
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("Hello, world");
    expect(body.choices[0].finish_reason).toBe("stop");

    expect(res.headers.get("x-crossbar-generation-id")).toMatch(/^gen_/);
    expect(res.headers.get("x-crossbar-provider")).toBe("anthropic");
    expect(res.headers.get("x-crossbar-endpoint")).toBe("test/dual::anthropic");
  });

  it("routes to the cheapest endpoint by default", async () => {
    harness = await createHarness();
    await postChat(harness.app, { model: "test/dual", messages: [{ role: "user", content: "hi" }] });

    // $1 anthropic beats $9 openai under inverse-square weighting.
    expect(harness.anthropic.received).toHaveLength(1);
    expect(harness.openai.received).toHaveLength(0);
  });

  it("translates the request into the Anthropic dialect on the wire", async () => {
    harness = await createHarness();
    await postChat(harness.app, {
      model: "test/dual",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
      ],
      temperature: 0.9,
    });

    const sent = harness.anthropic.received[0]!.body;
    expect(sent.model).toBe(CHEAP);
    expect(sent.system).toEqual([{ type: "text", text: "Be terse." }]);
    expect(sent.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(sent.max_tokens).toBe(4096); // clamped to the endpoint ceiling
    expect(sent.temperature).toBeUndefined(); // stripped: unsupported on this endpoint
    expect(sent.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("reports usage with cost in USD", async () => {
    harness = await createHarness();
    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
    });
    const body = (await res.json()) as Record<string, any>;

    // Fake emits 11 input + 3 cache-read + 7 output.
    expect(body.usage.prompt_tokens).toBe(14);
    expect(body.usage.completion_tokens).toBe(7);
    expect(body.usage.prompt_tokens_details.cached_tokens).toBe(3);

    // 11 uncached @ $1/MTok + 3 cached @ $0.10/MTok + 7 out @ $1/MTok
    // = 11 + 0.3 + 7 = 18.3 micro-USD, rounded to 18.
    expect(body.usage.cost).toBeCloseTo(18 / 1_000_000, 12);
  });

  it("surfaces tool calls", async () => {
    harness = await createHarness({ anthropic: { script: "tool-call" } });

    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object" } },
        },
      ],
    });

    const body = (await res.json()) as Record<string, any>;
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls).toEqual([
      {
        id: "toolu_fake1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ]);
  });
});

describe("streaming completions", () => {
  it("emits OpenAI chunks terminated by [DONE]", async () => {
    harness = await createHarness();

    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });

    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = await readSse(res);

    expect(events[0]).toMatchObject({
      object: "chat.completion.chunk",
      choices: [{ delta: { role: "assistant" } }],
    });
    expect(joinContent(events)).toBe("Hello, world");
    expect(events.at(-1)).toBe("[DONE]");
  });

  it("withholds the usage frame unless the client asks for it", async () => {
    harness = await createHarness();

    const without = await readSse(
      await postChat(harness.app, {
        model: "test/dual",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );
    expect(without.some((e) => e !== "[DONE]" && e.usage)).toBe(false);

    const withUsage = await readSse(
      await postChat(harness.app, {
        model: "test/dual",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    );
    const usageFrame = withUsage.find((e) => e !== "[DONE]" && e.usage) as Record<string, any>;
    expect(usageFrame.usage.completion_tokens).toBe(7);
    expect(usageFrame.usage.cost).toBeGreaterThan(0);
  });

  it("streams tool calls with a zero-based tool_calls index", async () => {
    harness = await createHarness({ anthropic: { script: "tool-call" } });

    const events = await readSse(
      await postChat(harness.app, {
        model: "test/dual",
        messages: [{ role: "user", content: "weather?" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
        stream: true,
      }),
    );

    const toolDeltas = events
      .filter((e): e is Record<string, any> => e !== "[DONE]")
      .flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? []);

    // The tool_use block was at Anthropic index 1, behind a text block.
    expect(toolDeltas.every((t: any) => t.index === 0)).toBe(true);
    expect(toolDeltas[0].function.name).toBe("get_weather");
    expect(toolDeltas.map((t: any) => t.function.arguments ?? "").join("")).toBe('{"city":"Paris"}');

    const finish = events
      .filter((e): e is Record<string, any> => e !== "[DONE]")
      .map((e) => e.choices?.[0]?.finish_reason)
      .filter(Boolean);
    expect(finish).toContain("tool_calls");
  });

  it("records the generation, readable as soon as [DONE] arrives", async () => {
    harness = await createHarness();

    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    await readSse(res);

    const id = res.headers.get("x-crossbar-generation-id")!;
    const gen = await harness.app.request(`/v1/generation?id=${id}`);
    const record = (await gen.json()) as Record<string, any>;

    expect(record.data.streamed).toBe(true);
    expect(record.data.finish_reason).toBe("stop");
    expect(record.data.tokens_completion).toBe(7);
    expect(record.data.total_cost).toBeGreaterThan(0);
  });
});

describe("request validation and auth", () => {
  it("rejects an unknown model with 404", async () => {
    harness = await createHarness();
    const res = await postChat(harness.app, {
      model: "nope/missing",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe("not_found");
  });

  it("rejects an unknown top-level field", async () => {
    harness = await createHarness();
    const res = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
      nonsense: true,
    });
    expect(res.status).toBe(400);
  });

  it("requires messages", async () => {
    harness = await createHarness();
    const res = await postChat(harness.app, { model: "test/dual", messages: [] });
    expect(res.status).toBe(400);
  });

  it("401s without a key and succeeds with one", async () => {
    harness = await createHarness({ apiKeys: ["sk-test-key"] });

    const anon = await postChat(harness.app, {
      model: "test/dual",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(anon.status).toBe(401);

    const wrong = await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer sk-wrong" },
    );
    expect(wrong.status).toBe(401);

    const ok = await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer sk-test-key" },
    );
    expect(ok.status).toBe(200);
  });

  it("attributes the generation to a key id, never the key itself", async () => {
    harness = await createHarness({ apiKeys: ["sk-test-key"] });
    const res = await postChat(
      harness.app,
      { model: "test/dual", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer sk-test-key" },
    );
    const id = ((await res.json()) as any).id;

    const [row] = await harness.db.db.query.generations.findMany();
    expect(row?.id).toBe(id);
    expect(row?.keyId).toMatch(/^key_[0-9a-f]{16}$/);
    expect(JSON.stringify(row)).not.toContain("sk-test-key");
  });
});

describe("catalog endpoints", () => {
  it("lists models with per-endpoint pricing", async () => {
    harness = await createHarness();
    const res = await harness.app.request("/v1/models");
    const body = (await res.json()) as Record<string, any>;

    expect(body.object).toBe("list");
    const dual = body.data.find((m: any) => m.id === "test/dual");
    expect(dual.endpoints).toHaveLength(2);
    expect(dual.endpoints[0].provider_name).toBe("anthropic");
    expect(dual.endpoints[0].unsupported_parameters).toContain("temperature");
  });

  it("serves a single model by author/slug", async () => {
    harness = await createHarness();
    const res = await harness.app.request("/v1/models/test/dual");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.id).toBe("test/dual");

    expect((await harness.app.request("/v1/models/test/nope")).status).toBe(404);
  });

  it("reports health without auth, and checks the database", async () => {
    harness = await createHarness({ apiKeys: ["sk-test-key"] });
    const res = await harness.app.request("/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.database).toBe("ok");
    expect(body.models).toBeGreaterThan(0);
    expect(body.providers).toEqual(["anthropic", "openai"]);
  });

  it("reports 503 when the catalog store is unreachable", async () => {
    // Reporting "ok" here would keep a broken instance in the load balancer
    // pool while every request it received failed.
    harness = await createHarness();
    await harness.db.close();

    const res = await harness.app.request("/health");
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).database).toBe("unreachable");

    // Already closed; stop afterEach from double-closing.
    harness.close = async () => {};
  });
});
