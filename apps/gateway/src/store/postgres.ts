import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { generations, type NewGeneration } from "../db/schema.js";
import type {
  ActivityRow,
  GenerationStore,
  GenerationView,
  KeyUsage,
} from "./types.js";
import { EMPTY_USAGE } from "./types.js";

/** The durable store. Aggregates in SQL rather than loading rows. */
export class PostgresStore implements GenerationStore {
  readonly kind = "postgres" as const;
  readonly durable = true;

  constructor(private readonly db: DB) {}

  async record(row: NewGeneration): Promise<void> {
    await this.db.insert(generations).values(row);
  }

  async get(id: string, keyId: string | null): Promise<GenerationView | undefined> {
    const scope =
      keyId === null
        ? eq(generations.id, id)
        : and(eq(generations.id, id), eq(generations.keyId, keyId));

    const [row] = await this.db.select().from(generations).where(scope).limit(1);
    return row as GenerationView | undefined;
  }

  async usage(keyId: string | null): Promise<KeyUsage> {
    const [row] = await this.db
      .select({
        requests: sql<number>`count(*)`.mapWith(Number),
        costMicro: sql<number>`coalesce(sum(${generations.costMicro}), 0)`.mapWith(Number),
        promptTokens: sql<number>`coalesce(sum(${generations.promptTokens}), 0)`.mapWith(Number),
        completionTokens:
          sql<number>`coalesce(sum(${generations.completionTokens}), 0)`.mapWith(Number),
      })
      .from(generations)
      .where(keyId === null ? sql`true` : eq(generations.keyId, keyId));

    return row ?? EMPTY_USAGE;
  }

  async activity(keyId: string | null, since: Date): Promise<ActivityRow[]> {
    const day = sql<string>`to_char(${generations.createdAt}, 'YYYY-MM-DD')`;
    const scope =
      keyId === null
        ? gte(generations.createdAt, since)
        : and(gte(generations.createdAt, since), eq(generations.keyId, keyId));

    return this.db
      .select({
        date: day,
        model: generations.requestedModel,
        provider: generations.provider,
        requests: sql<number>`count(*)`.mapWith(Number),
        promptTokens: sql<number>`coalesce(sum(${generations.promptTokens}), 0)`.mapWith(Number),
        completionTokens:
          sql<number>`coalesce(sum(${generations.completionTokens}), 0)`.mapWith(Number),
        costMicro: sql<number>`coalesce(sum(${generations.costMicro}), 0)`.mapWith(Number),
        errors: sql<number>`count(*) filter (where ${generations.error} is not null)`.mapWith(
          Number,
        ),
      })
      .from(generations)
      .where(scope)
      .groupBy(day, generations.requestedModel, generations.provider)
      .orderBy(desc(day));
  }

  async ping(): Promise<boolean> {
    await this.db.execute(sql`select 1`);
    return true;
  }
}
