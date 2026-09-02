import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Import a model catalog from an OpenAI-compatible aggregator.
 *
 * Model names, context windows and prices are published facts that change
 * often, and hand-maintaining hundreds of them would guarantee they are wrong.
 * This pulls them from a live source into a checked-in file, so the gateway
 * still boots with no network and the data has a visible provenance and date.
 *
 * Run with `pnpm catalog:sync`.
 */

const SOURCE = process.env.CROSSBAR_CATALOG_SOURCE ?? "https://openrouter.ai/api/v1/models";

export interface ImportedModel {
  id: string;
  name: string;
  description: string | null;
  contextLength: number;
  maxOutputTokens: number | null;
  inputModalities: string[];
  outputModalities: string[];
  /** USD per token, as published. */
  pricePrompt: number;
  priceCompletion: number;
  priceCacheRead: number | null;
  priceCacheWrite: number | null;
  supportsTools: boolean;
  supportsReasoning: boolean;
}

export interface ImportedCatalog {
  source: string;
  fetchedAt: string;
  models: ImportedModel[];
}

export interface RawModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  top_provider?: { max_completion_tokens?: number | null };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: Record<string, string>;
  supported_parameters?: string[];
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalize(raw: RawModel[]): ImportedModel[] {
  const out: ImportedModel[] = [];

  for (const m of raw) {
    // `:batch` and similar suffixes are billing variants of a model already in
    // the list; carrying them would double the catalog with near-duplicates.
    if (m.id.includes(":")) continue;

    const prompt = num(m.pricing?.prompt);
    const completion = num(m.pricing?.completion);
    if (prompt === null || completion === null) continue;

    // Some entries publish -1 to mean "varies by underlying model". Left in,
    // that reads as cheaper than free: the inverse-square weighting would send
    // every request there, and every generation would bill a negative amount.
    if (prompt < 0 || completion < 0) continue;

    const params = new Set(m.supported_parameters ?? []);
    out.push({
      id: m.id,
      name: m.name,
      // Trimmed: the full text is several paragraphs for some models, and the
      // catalog is loaded into memory on every cold start.
      description: (m.description ?? "").split("\n")[0]?.slice(0, 220).trim() || null,
      contextLength: m.context_length ?? 8_192,
      maxOutputTokens: m.top_provider?.max_completion_tokens ?? null,
      inputModalities: m.architecture?.input_modalities ?? ["text"],
      outputModalities: m.architecture?.output_modalities ?? ["text"],
      pricePrompt: prompt,
      priceCompletion: completion,
      priceCacheRead: num(m.pricing?.input_cache_read),
      priceCacheWrite: num(m.pricing?.input_cache_write),
      supportsTools: params.has("tools"),
      supportsReasoning: params.has("reasoning") || params.has("reasoning_effort"),
    });
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function syncCatalog(): Promise<ImportedCatalog> {
  const res = await fetch(SOURCE, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`catalog source returned ${res.status}`);

  const body = (await res.json()) as { data?: RawModel[] };
  const models = normalize(body.data ?? []);
  if (models.length === 0) throw new Error("catalog source returned no usable models");

  return { source: SOURCE, fetchedAt: new Date().toISOString(), models };
}

if (import.meta.filename === process.argv[1]) {
  const catalog = await syncCatalog();
  const out = join(import.meta.dirname, "catalog-data.json");
  writeFileSync(out, JSON.stringify(catalog, null, 0) + "\n");
  console.log(`[crossbar] imported ${catalog.models.length} models from ${catalog.source}`);
}
