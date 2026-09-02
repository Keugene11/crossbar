import { Hono } from "hono";

/**
 * Scriptable stand-ins for the Anthropic and OpenAI APIs.
 *
 * Wired into the adapters through the SDKs' `fetch` option, so tests exercise
 * the real client code -- serialization, SSE parsing, error classes -- with no
 * ports, no network, and no flakiness.
 *
 * Behaviour is keyed by the *upstream model id* in the request body, which is
 * how a test gives two endpoints of the same provider different fates and makes
 * the cascade observable.
 */
export type Script =
  | "ok"
  | "tool-call"
  | "429"
  | "500"
  | "529"
  | "400"
  | "401"
  | "timeout"
  | "slow-stream"
  | "fail-after-first-chunk";

export interface FakeUpstreamOptions {
  /** Default for any model not named in `scripts`. */
  script?: Script;
  scripts?: Record<string, Script>;
  /** Text the `ok` script emits, one SSE delta per element. */
  chunks?: string[];
  /** Delay per chunk under `slow-stream`, ms. */
  slowMs?: number;
}

export interface FakeUpstream {
  fetch: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>;
  /** Every request body the fake received, in order. Assert translation on these. */
  received: Array<{ path: string; body: Record<string, unknown> }>;
  setScript(model: string, script: Script): void;
  reset(): void;
}

const DEFAULT_CHUNKS = ["Hello", ", ", "world"];

function errorStatus(script: Script): number | null {
  switch (script) {
    case "400":
      return 400;
    case "401":
      return 401;
    case "429":
      return 429;
    case "500":
      return 500;
    case "529":
      return 529;
    default:
      return null;
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createFakeUpstream(opts: FakeUpstreamOptions = {}): FakeUpstream {
  const scripts = new Map(Object.entries(opts.scripts ?? {}));
  const fallback: Script = opts.script ?? "ok";
  const chunks = opts.chunks ?? DEFAULT_CHUNKS;
  const slowMs = opts.slowMs ?? 50;
  const received: FakeUpstream["received"] = [];

  const scriptFor = (model: unknown): Script =>
    (typeof model === "string" ? scripts.get(model) : undefined) ?? fallback;

  const app = new Hono();

  // ---- Anthropic Messages API ----
  app.post("/v1/messages", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    received.push({ path: "/v1/messages", body });
    const script = scriptFor(body.model);

    const status = errorStatus(script);
    if (status !== null) {
      return c.json(
        { type: "error", error: { type: "api_error", message: `fake upstream: ${script}` } },
        status as never,
      );
    }
    if (script === "timeout") {
      await sleep(60_000);
      return c.text("unreachable");
    }

    if (!body.stream) {
      return c.json(anthropicMessage(script, chunks, String(body.model)));
    }
    return new Response(anthropicStream(script, chunks, String(body.model), slowMs), {
      headers: { "content-type": "text/event-stream" },
    });
  });

  // ---- OpenAI Chat Completions ----
  app.post("/v1/chat/completions", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    received.push({ path: "/v1/chat/completions", body });
    const script = scriptFor(body.model);

    const status = errorStatus(script);
    if (status !== null) {
      return c.json(
        { error: { type: "api_error", message: `fake upstream: ${script}` } },
        status as never,
      );
    }
    if (script === "timeout") {
      await sleep(60_000);
      return c.text("unreachable");
    }

    if (!body.stream) {
      return c.json(openaiCompletion(script, chunks, String(body.model)));
    }
    return new Response(openaiStream(script, chunks, String(body.model), slowMs), {
      headers: { "content-type": "text/event-stream" },
    });
  });

  return {
    // The SDKs call fetch as (url, init), not with a Request, so normalise.
    fetch: (input: string | URL | Request, init?: RequestInit) =>
      app.fetch(input instanceof Request && init === undefined ? input : new Request(input, init)),
    received,
    setScript: (model, script) => scripts.set(model, script),
    reset: () => {
      received.length = 0;
      scripts.clear();
    },
  };
}

// ---------------------------------------------------------------- Anthropic

function anthropicMessage(script: Script, chunks: string[], model: string): unknown {
  const content =
    script === "tool-call"
      ? [
          { type: "text", text: "Looking that up." },
          { type: "tool_use", id: "toolu_fake1", name: "get_weather", input: { city: "Paris" } },
        ]
      : [{ type: "text", text: chunks.join("") }];

  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: script === "tool-call" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
  };
}

function anthropicStream(
  script: Script,
  chunks: string[],
  model: string,
  slowMs: number,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const w = (s: string): void => controller.enqueue(enc.encode(s));

      w(
        frame("message_start", {
          type: "message_start",
          message: {
            id: "msg_fake",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 3 },
          },
        }),
      );

      if (script === "fail-after-first-chunk") {
        w(frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        w(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunks[0] ?? "x" } }));
        // A real mid-stream failure arrives as an `error` event, not a torn
        // connection -- and `controller.error()` would discard the frames
        // already queued above, which is exactly what must NOT happen here.
        w(
          frame("error", {
            type: "error",
            error: { type: "overloaded_error", message: "fake upstream: overloaded mid-stream" },
          }),
        );
        controller.close();
        return;
      }

      if (script === "tool-call") {
        w(frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        w(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking that up." } }));
        w(frame("content_block_stop", { type: "content_block_stop", index: 0 }));
        // Block index 1, but OpenAI tool_calls index 0 -- the mapping under test.
        w(
          frame("content_block_start", {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_fake1", name: "get_weather", input: {} },
          }),
        );
        w(frame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } }));
        w(frame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Paris"}' } }));
        w(frame("content_block_stop", { type: "content_block_stop", index: 1 }));
        w(frame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }));
        w(frame("message_stop", { type: "message_stop" }));
        controller.close();
        return;
      }

      w(frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
      for (const text of chunks) {
        if (script === "slow-stream") await sleep(slowMs);
        w(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
      }
      w(frame("content_block_stop", { type: "content_block_stop", index: 0 }));
      w(frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }));
      w(frame("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });
}

// ------------------------------------------------------------------ OpenAI

function openaiCompletion(script: Script, chunks: string[], model: string): unknown {
  const message =
    script === "tool-call"
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_fake1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ],
        }
      : { role: "assistant", content: chunks.join("") };

  return {
    id: "chatcmpl_fake",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [
      { index: 0, message, finish_reason: script === "tool-call" ? "tool_calls" : "stop" },
    ],
    usage: {
      prompt_tokens: 14,
      completion_tokens: 7,
      total_tokens: 21,
      prompt_tokens_details: { cached_tokens: 3 },
    },
  };
}

function openaiStream(
  script: Script,
  chunks: string[],
  model: string,
  slowMs: number,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const base = { id: "chatcmpl_fake", object: "chat.completion.chunk", created: 1_700_000_000, model };
  const data = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

  return new ReadableStream({
    async start(controller) {
      const w = (s: string): void => controller.enqueue(enc.encode(s));

      w(data({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));

      if (script === "fail-after-first-chunk") {
        w(data({ ...base, choices: [{ index: 0, delta: { content: chunks[0] ?? "x" }, finish_reason: null }] }));
        w(data({ error: { type: "server_error", message: "fake upstream: failed mid-stream" } }));
        controller.close();
        return;
      }

      for (const content of chunks) {
        if (script === "slow-stream") await sleep(slowMs);
        w(data({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] }));
      }
      w(data({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      w(
        data({
          ...base,
          choices: [],
          usage: {
            prompt_tokens: 14,
            completion_tokens: 7,
            total_tokens: 21,
            prompt_tokens_details: { cached_tokens: 3 },
          },
        }),
      );
      w("data: [DONE]\n\n");
      controller.close();
    },
  });
}
