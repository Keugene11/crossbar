import { eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import {
  endpoints as endpointsTable,
  models as modelsTable,
  providers as providersTable,
} from "../db/schema.js";
import type { EndpointRow, ModelRow, ProviderRow } from "../db/schema.js";
import { CrossbarError } from "../errors.js";

export type Endpoint = EndpointRow;
export type Model = ModelRow;
export type Provider = ProviderRow;

export interface CatalogSnapshot {
  providers: Provider[];
  models: Model[];
  byModelId: Map<string, Model>;
  endpointsByModelId: Map<string, Endpoint[]>;
  byEndpointId: Map<string, Endpoint>;
}

function buildSnapshot(
  models: Model[],
  endpoints: Endpoint[],
  providers: Provider[] = [],
): CatalogSnapshot {
  models.sort((a, b) => a.id.localeCompare(b.id));
  const byModelId = new Map(models.map((m) => [m.id, m]));
  const endpointsByModelId = new Map<string, Endpoint[]>();
  const byEndpointId = new Map<string, Endpoint>();

  for (const e of endpoints) {
    if (e.status !== "active") continue;
    byEndpointId.set(e.id, e);
    const list = endpointsByModelId.get(e.modelId);
    if (list) list.push(e);
    else endpointsByModelId.set(e.modelId, [e]);
  }

  // Postgres returns rows in no guaranteed order, which would make routing
  // non-reproducible run to run. Cheapest-first with an id tiebreak gives every
  // selection strategy a stable input.
  for (const list of endpointsByModelId.values()) {
    list.sort(
      (a, b) =>
        a.pricePromptMicro + a.priceCompletionMicro -
          (b.pricePromptMicro + b.priceCompletionMicro) || a.id.localeCompare(b.id),
    );
  }
  providers.sort((a, b) => a.id.localeCompare(b.id));
  return { providers, models, byModelId, endpointsByModelId, byEndpointId };
}

/**
 * In-memory view of the catalog, refreshed on a TTL.
 *
 * The request path reads only from here -- routing a completion must never wait
 * on Postgres.
 */
/** Where a catalog snapshot comes from. */
export type CatalogSource = () => Promise<{
  models: Model[];
  endpoints: Endpoint[];
  providers: Provider[];
}>;

export function databaseSource(db: DB): CatalogSource {
  return async () => {
    const [models, endpoints, providers] = await Promise.all([
      db.select().from(modelsTable),
      db.select().from(endpointsTable).where(eq(endpointsTable.status, "active")),
      db.select().from(providersTable),
    ]);
    return { models, endpoints, providers };
  };
}

/**
 * A fixed snapshot, for deployments with no database.
 *
 * The catalog is static configuration rather than mutable state, so serving it
 * from the compiled-in seed loses nothing except the ability to edit it at
 * runtime -- which a serverless instance could not do anyway.
 */
export function staticSource(
  models: Model[],
  endpoints: Endpoint[],
  providers: Provider[],
): CatalogSource {
  return async () => ({ models, endpoints, providers });
}

export class Catalog {
  #snapshot: CatalogSnapshot = buildSnapshot([], [], []);
  #loadedAt = 0;
  #inflight: Promise<void> | undefined;
  readonly #source: CatalogSource;

  constructor(source: CatalogSource | DB, private readonly ttlMs: number) {
    this.#source = typeof source === "function" ? source : databaseSource(source as DB);
  }

  async refresh(): Promise<void> {
    const { models, endpoints, providers } = await this.#source();
    this.#snapshot = buildSnapshot(models, endpoints, providers);
    this.#loadedAt = Date.now();
  }

  /** Refreshes if the snapshot is stale; concurrent callers share one round-trip. */
  async ensureFresh(): Promise<CatalogSnapshot> {
    if (Date.now() - this.#loadedAt < this.ttlMs) return this.#snapshot;
    this.#inflight ??= this.refresh().finally(() => {
      this.#inflight = undefined;
    });
    await this.#inflight;
    return this.#snapshot;
  }

  get snapshot(): CatalogSnapshot {
    return this.#snapshot;
  }

  /** Models in stable id order. Sorted once per snapshot, not per call. */
  listModels(): readonly Model[] {
    return this.#snapshot.models;
  }

  getModel(id: string): Model | undefined {
    return this.#snapshot.byModelId.get(id);
  }

  getEndpoint(id: string): Endpoint | undefined {
    return this.#snapshot.byEndpointId.get(id);
  }

  /** Active endpoints for a model, or an empty array when the model is unknown. */
  endpointsFor(modelId: string): Endpoint[] {
    return this.#snapshot.endpointsByModelId.get(modelId) ?? [];
  }

  /** Like `endpointsFor`, but a 404 for an unknown model beats a silent empty list. */
  requireEndpointsFor(modelId: string): Endpoint[] {
    if (!this.#snapshot.byModelId.has(modelId)) {
      throw new CrossbarError({
        status: 404,
        code: "not_found",
        message: `No such model: "${modelId}"`,
        retryable: false,
      });
    }
    const list = this.endpointsFor(modelId);
    if (list.length === 0) {
      throw new CrossbarError({
        status: 502,
        code: "no_endpoints",
        message: `Model "${modelId}" has no active endpoints`,
        retryable: false,
      });
    }
    return list;
  }
}
