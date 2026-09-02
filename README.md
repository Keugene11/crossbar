# crossbar

An OpenRouter-style LLM routing gateway. One API key, one wire format, many
upstream providers, with automatic routing and failover.

Speak the OpenAI Chat Completions API at crossbar, name a model as
`provider/model`, and crossbar picks an upstream endpoint by policy, translates
the request into that provider's native dialect, streams the response back
re-normalized into OpenAI SSE chunks, cascades to the next candidate on failure,
and records tokens and cost for every generation.

```bash
curl localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $CROSSBAR_KEY" -H 'content-type: application/json' \
  -d '{
    "model": "anthropic/claude-opus-5",
    "models": ["openai/gpt-5"],
    "provider": { "sort": "price" },
    "messages": [{ "role": "user", "content": "hello" }]
  }'
```

## Quick start

```bash
pnpm install
pnpm dev            # http://localhost:8080 -- migrates and seeds on first run
```

No database to install: with `DATABASE_URL` unset, crossbar runs on
[PGlite](https://pglite.dev) — real Postgres compiled to WASM, stored in
`.pglite/`. Set `DATABASE_URL` to use a server instead (`docker-compose.yml`
brings one up). PGlite allows **one process per datadir**, so stop the server
before running `pnpm db:seed` against the same directory.

Copy `apps/gateway/.env.example` to `.env` and fill in `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` for the providers you want to reach. `CROSSBAR_API_KEYS` is a
comma-separated allowlist of bearer keys; leave it empty to disable auth locally.

## API

Served under both `/v1` and `/api/v1`, so a client can repoint from OpenRouter
by changing the host alone.

| Endpoint | Purpose |
|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible completions, buffered or streaming |
| `GET /v1/models` | Catalog with per-endpoint pricing and capabilities |
| `GET /v1/models/:author/:slug` | One model |
| `GET /v1/models/:author/:slug/endpoints` | Endpoint-level detail for one model |
| `GET /v1/generation?id=` | Tokens, cost, latency, and the full attempt list |
| `GET /health` | Liveness (no auth) |

Beyond the OpenAI request body, crossbar accepts:

- **`models: string[]`** — model-level fallback chain, tried in order once the
  primary model's endpoints are exhausted.
- **`provider`** — routing preferences: `order`, `sort` (`price` /
  `throughput` / `latency`), `allow_fallbacks`, `only`, `ignore`, `max_price`.
- **`usage: { include: true }`** — force usage accounting into the final chunk.
- **Variant suffixes** — `anthropic/claude-opus-5:floor` routes cheapest-first,
  `:nitro` routes by throughput. Sugar over `provider.sort`; an explicit `sort`
  wins. An unrecognised suffix stays part of the model id rather than silently
  resolving to a different model.
- **`provider.require_parameters`** — refuse endpoints that would silently drop
  something the request depends on. Without it, a tool-calling request can land
  on an endpoint that ignores `tools` and answers in prose.
- **`HTTP-Referer` / `X-Title`** — app attribution, recorded per generation.

Every response carries `X-Crossbar-Generation-Id`, `X-Crossbar-Provider`,
`X-Crossbar-Model`, `X-Crossbar-Endpoint`, and `X-Crossbar-Attempts` — on
failures too, so a request that ended in a 502 is still traceable through
`/v1/generation`.

## How routing works

**Selection.** With no `sort` or `order`, crossbar reproduces OpenRouter's
documented default:

1. Endpoints that failed within the last 30 seconds are *deprioritised*, not
   dropped.
2. The rest are ordered by **inverse-square price weighting** — weight ∝
   `1 / price²`, so a $1/MTok endpoint is roughly 9× more likely to be tried
   first than a $3/MTok one.
3. Whatever remains becomes the fallback chain, in that order.

An explicit `sort` or `order` replaces steps 1–2 with a deterministic order.

**The cascade.** One invariant shapes the whole design: *once a byte reaches the
client, no other endpoint can be tried.* An attempt is committed only when its
first chunk arrives.

- Fails **before** the first chunk → recorded, next candidate takes over.
- Fails **after** the first chunk → a terminal error frame inside the open
  stream, then `[DONE]`. No retry, no silently truncated answer.

Failure handling is per-status, because not every failure means the same thing:

| Upstream result | Action |
|---|---|
| 429, 408, 5xx | try the next endpoint |
| 401, 403 | skip every endpoint of that provider, continue with others |
| 404 | try the next endpoint (another provider may know the model) |
| 400, 413, 422 | stop — the request itself is wrong, and fails identically everywhere |

Credentials are a property of the provider account, not the request, so one
expired key retires that provider for the request instead of failing it.

**Accounting.** Prices are integer micro-USD per million tokens, never floats;
cost is rounded exactly once, at the end. Cache reads and cache writes bill at
their own rates and are counted *inside* `prompt_tokens`, not added to it.
Failed requests are never billed, even when a cascade burned three providers
first.

## Security

- **Generation records are scoped to the owning key.** Ids travel in response
  headers and logs, so holding one is not authorisation; a mismatch returns 404
  rather than 403 so it cannot be used to probe for existence.
- **Bearer keys are compared in constant time** against digests precomputed at
  startup, with no early exit, so neither key length nor which key matched
  leaks. Generations are attributed by a `key_<hash>` id — the key itself never
  reaches the database.
- **Every fan-out is bounded**: request body (24 MB, enforced before auth),
  message count, tool count, fallback-model chain, and total upstream attempts
  per request. Upstream error bodies are truncated before being echoed back or
  stored.
- **Client disconnects propagate upstream** for the life of a stream, so a
  client hanging up stops the generation instead of leaving it billing.
- `pnpm audit` is clean.

## Adding a provider

A provider is one file. The gateway speaks OpenAI Chat Completions internally,
so an adapter only translates at the boundary:

```ts
interface ProviderAdapter {
  readonly id: string;
  invoke(request, endpoint, signal): Promise<ChatCompletion>;
  invokeStream(request, endpoint, signal): AsyncIterable<ChatCompletionChunk>;
  classifyError(err): CrossbarError;
}
```

Register it in `src/index.ts` and add endpoints to `src/registry/seed.ts`.
Per-endpoint `unsupportedParams` let the adapter strip fields an upstream
rejects (`temperature` on Anthropic's current tier, forced `tool_choice` on
Fable-tier) instead of forwarding a request that would 400. An endpoint may
also carry its own `baseUrl` — for a regional deployment or a self-hosted
OpenAI-compatible server — and the adapter keeps one client per host.

## Layout

```
src/
  routes/       chat, models, generation, health
  schemas/      Zod contracts -- the OpenAI wire format is the internal one too
  registry/     catalog cache + seed data
  routing/      candidates -> select -> execute (the cascade), variants, health stats
  providers/    anthropic/ (dialect translation), openai/ (reference), classify
  accounting/   cost math and the generation ledger
  db/           Drizzle schema, migrations, dual PGlite / node-postgres driver
```

## Tests

```bash
pnpm test         # 107 tests, no network, no ports
pnpm test:live    # LIVE=1 -- real provider calls, costs money
pnpm audit        # dependency vulnerabilities
```

Tests run against a scriptable fake upstream wired into the SDKs through their
`fetch` option, so the real client code — serialization, SSE parsing, error
classes — is exercised in-process. The fake can be told to return `429`, `500`,
`529`, `timeout`, `slow-stream`, `tool-call`, or `fail-after-first-chunk`,
keyed per upstream model id so one test can give two endpoints different fates.

Routing is deterministic under test: the RNG is injected, and the catalog sorts
endpoints cheapest-first before selection.

## Scope

This is the routing gateway — the part that does the interesting work.
Deliberately **not** included: API key issuance, credit ledger and billing,
BYOK, a web dashboard, embeddings/images/audio, and org/workspace management.
The seams are in place (`auth.ts` owns the only `keyId` contract; `routing/
stats.ts` is where a shared health store would go), but none of it is built.
