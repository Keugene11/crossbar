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
| `POST /v1/completions` | Legacy text completions, for older clients |
| `GET /v1/models` | Catalog with per-endpoint pricing and capabilities |
| `GET /v1/models/:author/:slug` | One model |
| `GET /v1/models/:author/:slug/endpoints` | Endpoint-level detail for one model |
| `GET /v1/generation?id=` | Tokens, cost, latency, and the full attempt list |
| `GET /v1/key` | The calling key's own usage and rate limit |
| `GET /v1/providers` | Provider directory with data-retention policy |
| `GET /v1/activity?days=` | Daily usage rolled up by model and provider |
| `GET /health` | Liveness (no auth) |

Beyond the OpenAI request body, crossbar accepts:

- **`models: string[]`** — model-level fallback chain, tried in order once the
  primary model's endpoints are exhausted.
- **`provider`** — routing preferences: `order`, `sort` (`price` /
  `throughput` / `latency`), `allow_fallbacks`, `only`, `ignore`, `max_price`,
  `require_parameters`, `data_collection`, `quantizations`.
- **`usage: { include: true }`** — force usage accounting into the final chunk.
- **Variant suffixes** — `anthropic/claude-opus-5:floor` routes cheapest-first,
  `:nitro` routes by throughput. Sugar over `provider.sort`; an explicit `sort`
  wins. An unrecognised suffix stays part of the model id rather than silently
  resolving to a different model.
- **`provider.require_parameters`** — refuse endpoints that would silently drop
  something the request depends on. Without it, a tool-calling request can land
  on an endpoint that ignores `tools` and answers in prose.
- **`HTTP-Referer` / `X-Title`** — app attribution, recorded per generation.
- **`cache_control`** on any text part — a prompt-cache breakpoint, passed
  through to providers that support caching. Placement stays the caller's
  decision, because it depends on which prefix of *their* prompt is stable,
  which the gateway cannot know. Cache reads then bill at the cache rate.
- **`cost_tier` / `allowed_models`** — spend ceiling and allowlist for the auto
  router.
- **`transforms: ["middle-out"]`** — compress an over-long prompt to fit instead
  of failing it. Opt-in on purpose: dropped turns are invisible in the response
  and the model answers confidently without them, so it is not a safe default.
  Every system message and the final turn always survive, and a `tool` result is
  never orphaned from its call. The count lands in
  `X-Crossbar-Dropped-Messages`.

### The auto router

`model: "crossbar/auto"` picks a model instead of naming one. OpenRouter ranks
candidates by community spend; there is no community here, so the ranking comes
from the request itself — tools, images, and reasoning are hard gates, prompt
size must fit the window, and among everything that qualifies the cheapest wins.
Capability is a gate, not a gradient: paying for headroom the request never uses
is exactly the waste an auto router should avoid. Bound it with
`cost_tier` (`low`/`medium`/`high`/`max`) and `allowed_models`
(`["anthropic/*"]`).

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

**Policy routing.** `provider.data_collection: "deny"` routes only to endpoints
that do not retain or train on prompts, and `provider.quantizations` restricts
to named weight formats (a heavily quantized variant can underperform the same
model served elsewhere). Both *remove* candidates rather than deprioritise them:
a privacy or quality constraint the router quietly ignores when everything else
is down is not a constraint. `/v1/providers` publishes the retention policy each
one is filtered on — a routing control the caller cannot inspect is not much of
a control.

**Sizing.** Every candidate is checked against the request before it is tried:
an endpoint whose context window cannot hold the prompt plus the requested
output is skipped rather than attempted. If none can, the request fails 413
without a single upstream call — or, with `transforms: ["middle-out"]`, is
compressed from the middle until it fits (recall is strongest at the edges of a
window, so the instructions and the most recent turns are what to keep). The estimate is deliberately approximate — it
answers "can this possibly fit", not "what will this cost"; billing always uses
the counts the provider reports back.

**Accounting.** Prices are integer micro-USD per million tokens, never floats;
cost is rounded exactly once, at the end. Cache reads and cache writes bill at
their own rates and are counted *inside* `prompt_tokens`, not added to it.
Failed requests are never billed, even when a cascade burned three providers
first — and neither are generations that produced no output tokens
(zero-completion insurance): the provider still charges us for the prompt, but
the caller got nothing usable, so passing that on would be billing them for our
routing decision.

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
- **Per-caller rate limiting** (`CROSSBAR_RATE_LIMIT_RPM`, default 600/min) via
  a token bucket keyed by API key, falling back to forwarded IP. A bucket
  rather than a fixed window, because a window lets a caller spend a full quota
  at the end of one and again at the start of the next — twice the nominal rate
  against providers that bill for it. The bucket map is itself bounded and
  swept, since unauthenticated callers are keyed by a header they control.
- `pnpm audit` is clean, and CI runs it on every push.

`/v1/completions` is a thin shim: the prompt becomes a single user message and
the request re-enters the chat pipeline, so routing, failover, rate limiting and
the ledger have exactly one implementation between them. `/v1/activity`
aggregates in SQL rather than loading rows — a busy key accumulates millions of
generations, and summing them in memory would turn a reporting endpoint into an
outage.

## Deploying

```bash
docker build -t crossbar .
docker run -p 8080:8080   -e CROSSBAR_API_KEYS=... -e ANTHROPIC_API_KEY=... -e OPENAI_API_KEY=...   -v crossbar-data:/data crossbar
```

Multi-stage, non-root, with a `HEALTHCHECK` wired to `/health`. That endpoint is
readiness as well as liveness: it pings the catalog store and returns 503 when
the database is unreachable or the catalog is empty, so a broken instance drops
out of the pool instead of accepting traffic it cannot serve. Set `DATABASE_URL`
to point at a Postgres server; otherwise PGlite persists to the `/data` volume.

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
  routes/       chat, completions, models, providers, generation, key, activity
  schemas/      Zod contracts -- the OpenAI wire format is the internal one too
  registry/     catalog cache + seed data
  routing/      candidates -> select -> execute (the cascade)
                auto router, variants, token sizing, transforms, health stats
  providers/    anthropic/ (dialect translation), openai/ (reference), classify
  accounting/   cost math and the generation ledger
  db/           Drizzle schema, migrations, dual PGlite / node-postgres driver
```

## Tests

```bash
pnpm test         # 161 tests, no network, no ports
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
