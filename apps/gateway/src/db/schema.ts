import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { AttemptRecord } from "../errors.js";

/**
 * Money is stored as integer **micro-USD per million tokens** -- never a float.
 * $5.00/MTok is `5_000_000`. Cost of a generation is
 * `tokens * priceMicro / 1_000_000` micro-USD, rounded exactly once.
 */

export const models = pgTable("models", {
  /** Namespaced id, e.g. "anthropic/claude-opus-5". */
  id: text("id").primaryKey(),
  author: text("author").notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  contextLength: integer("context_length").notNull(),
  inputModalities: jsonb("input_modalities").$type<string[]>().notNull(),
  outputModalities: jsonb("output_modalities").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Provider-level metadata: the things a caller needs to decide whether a
 * provider is acceptable, independent of any one model.
 */
export const providers = pgTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Whether this provider may retain or train on prompts sent to it. */
  mayTrainOnData: boolean("may_train_on_data").notNull().default(false),
  privacyPolicyUrl: text("privacy_policy_url"),
  termsUrl: text("terms_url"),
  statusPageUrl: text("status_page_url"),
});

export const endpoints = pgTable(
  "endpoints",
  {
    /** "<model id>::<provider>", e.g. "anthropic/claude-opus-5::anthropic". */
    id: text("id").primaryKey(),
    modelId: text("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** The id this provider knows the model by. */
    upstreamModelId: text("upstream_model_id").notNull(),
    /** Null => the provider SDK's default base URL. */
    baseUrl: text("base_url"),

    pricePromptMicro: integer("price_prompt_micro").notNull(),
    priceCompletionMicro: integer("price_completion_micro").notNull(),
    priceCacheReadMicro: integer("price_cache_read_micro"),
    priceCacheWriteMicro: integer("price_cache_write_micro"),

    contextLength: integer("context_length").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),

    supportsTools: boolean("supports_tools").notNull().default(true),
    supportsStreaming: boolean("supports_streaming").notNull().default(true),
    supportsVision: boolean("supports_vision").notNull().default(false),
    supportsReasoning: boolean("supports_reasoning").notNull().default(false),

    /**
     * Request fields this endpoint rejects outright. The adapter strips these
     * rather than letting the upstream 400 -- e.g. `temperature` on Fable-tier
     * Anthropic models, where sampling params were removed.
     */
    unsupportedParams: jsonb("unsupported_params").$type<string[]>().notNull(),

    /**
     * Weight quantization served at this endpoint. A heavily quantized variant
     * of a model can underperform the same model elsewhere, so callers may
     * filter on it.
     */
    quantization: text("quantization"),
    /** Whether prompts sent here may be retained or trained on. */
    dataCollection: text("data_collection", { enum: ["allow", "deny"] })
      .notNull()
      .default("deny"),

    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    /** Manual tiebreak; higher wins when prices are equal. */
    priority: integer("priority").notNull().default(0),
  },
  (t) => [index("endpoints_model_id_idx").on(t.modelId)],
);

/**
 * Issued gateway keys and their credit balance.
 *
 * This is what makes crossbar usable by anyone other than its operator: the
 * operator holds the provider credentials once, and everyone else gets a key
 * with credit on it. A user of the gateway never needs an account with
 * Anthropic or OpenAI -- that relationship belongs to whoever runs the server.
 *
 * Only the hash is stored, so a database leak cannot be replayed as a key.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    /** "key_<sha256 prefix>", the same id used to attribute generations. */
    id: text("id").primaryKey(),
    /** sha256 of the key, hex. The key itself is shown once, at creation. */
    hash: text("hash").notNull().unique(),
    label: text("label"),

    /** Granted credit, micro-USD. Null means unlimited (an operator key). */
    creditMicro: bigint("credit_micro", { mode: "number" }),
    /** Consumed so far, micro-USD. */
    spentMicro: bigint("spent_micro", { mode: "number" }).notNull().default(0),

    disabled: boolean("disabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("api_keys_hash_idx").on(t.hash)],
);

export const generations = pgTable(
  "generations",
  {
    /** "gen_<uuid>" -- handed back in the response and `X-Crossbar-Generation-Id`. */
    id: text("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    keyId: text("key_id"),

    /** App attribution, from the HTTP-Referer / X-Title request headers. */
    appReferer: text("app_referer"),
    appTitle: text("app_title"),

    /** What the client asked for, before routing. */
    requestedModel: text("requested_model").notNull(),
    /** What was actually served, once an endpoint won. Null if none did. */
    modelId: text("model_id"),
    endpointId: text("endpoint_id"),
    provider: text("provider"),

    streamed: boolean("streamed").notNull().default(false),
    finishReason: text("finish_reason"),

    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costMicro: bigint("cost_micro", { mode: "number" }).notNull().default(0),

    latencyMs: integer("latency_ms"),
    ttftMs: integer("ttft_ms"),

    /** Every endpoint tried, in order, with its outcome. */
    attempts: jsonb("attempts").$type<AttemptRecord[]>().notNull(),
    error: jsonb("error").$type<{ code: string; status: number; message: string } | null>(),
  },
  (t) => [index("generations_created_at_idx").on(t.createdAt)],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type ProviderRow = typeof providers.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
export type EndpointRow = typeof endpoints.$inferSelect;
export type GenerationRow = typeof generations.$inferSelect;
export type NewGeneration = typeof generations.$inferInsert;
