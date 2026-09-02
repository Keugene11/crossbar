import { getDb, type DB } from "./client.js";
import { endpoints, models } from "./schema.js";
import { catalogSeed, endpointId, toMicro, type SeedModel } from "../registry/seed.js";

/** Idempotent upsert of the catalog. Safe to re-run after editing the seed. */
export async function seedCatalog(db: DB, data: SeedModel[] = catalogSeed): Promise<void> {
  for (const m of data) {
    const [author, ...rest] = m.id.split("/");
    const slug = rest.join("/");
    if (!author || !slug) throw new Error(`seed: model id must be "author/slug", got "${m.id}"`);

    await db
      .insert(models)
      .values({
        id: m.id,
        author,
        slug,
        name: m.name,
        description: m.description ?? null,
        contextLength: m.contextLength,
        inputModalities: m.inputModalities,
        outputModalities: m.outputModalities,
      })
      .onConflictDoUpdate({
        target: models.id,
        set: {
          name: m.name,
          description: m.description ?? null,
          contextLength: m.contextLength,
          inputModalities: m.inputModalities,
          outputModalities: m.outputModalities,
        },
      });

    for (const e of m.endpoints) {
      const row = {
        id: endpointId(m.id, e.provider),
        modelId: m.id,
        provider: e.provider,
        upstreamModelId: e.upstreamModelId,
        baseUrl: null,
        pricePromptMicro: toMicro(e.pricePrompt),
        priceCompletionMicro: toMicro(e.priceCompletion),
        priceCacheReadMicro: e.priceCacheRead === undefined ? null : toMicro(e.priceCacheRead),
        priceCacheWriteMicro: e.priceCacheWrite === undefined ? null : toMicro(e.priceCacheWrite),
        contextLength: e.contextLength ?? m.contextLength,
        maxOutputTokens: e.maxOutputTokens,
        supportsTools: e.supportsTools ?? true,
        supportsStreaming: true,
        supportsVision: e.supportsVision ?? false,
        supportsReasoning: e.supportsReasoning ?? false,
        unsupportedParams: e.unsupportedParams ?? [],
        status: "active" as const,
        priority: e.priority ?? 0,
      };
      await db.insert(endpoints).values(row).onConflictDoUpdate({ target: endpoints.id, set: row });
    }
  }
}

if (import.meta.filename === process.argv[1]) {
  const handle = getDb();
  await handle.migrate();
  await seedCatalog(handle.db);
  const count = catalogSeed.reduce((n, m) => n + m.endpoints.length, 0);
  console.log(`[crossbar] seeded ${catalogSeed.length} models / ${count} endpoints (${handle.driver})`);
  await handle.close();
}
