import type { NewGeneration } from "../db/schema.js";

/**
 * Persistence boundary for everything the gateway records.
 *
 * Routing and translation never touch storage, so the whole product runs
 * unchanged against Postgres or against memory. That is what makes a
 * serverless deployment possible: on a platform with no writable disk and no
 * connection pooling, a gateway that still routes, translates, fails over and
 * reports is far more useful than one that refuses to start.
 */
export interface GenerationStore {
  readonly kind: "postgres" | "memory";
  /** Whether recorded generations outlive the process. */
  readonly durable: boolean;

  record(row: NewGeneration): Promise<void>;

  /** Scoped by key: a null keyId means auth is disabled and all rows match. */
  get(id: string, keyId: string | null): Promise<GenerationView | undefined>;

  usage(keyId: string | null): Promise<KeyUsage>;

  activity(keyId: string | null, since: Date): Promise<ActivityRow[]>;

  /** Readiness probe. Throws or resolves false when the store is unusable. */
  ping(): Promise<boolean>;
}

export interface GenerationView {
  id: string;
  createdAt: Date;
  requestedModel: string;
  modelId: string | null;
  provider: string | null;
  endpointId: string | null;
  streamed: boolean;
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costMicro: number;
  latencyMs: number | null;
  ttftMs: number | null;
  attempts: unknown;
  error: unknown;
}

export interface KeyUsage {
  requests: number;
  costMicro: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ActivityRow {
  date: string;
  model: string;
  provider: string | null;
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  costMicro: number;
}

export const EMPTY_USAGE: KeyUsage = {
  requests: 0,
  costMicro: 0,
  promptTokens: 0,
  completionTokens: 0,
};
