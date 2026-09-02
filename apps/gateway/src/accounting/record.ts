import type { DB } from "../db/client.js";
import { generations, type NewGeneration } from "../db/schema.js";
import type { AttemptRecord } from "../errors.js";
import type { Endpoint } from "../registry/catalog.js";
import type { FinishReason, Usage } from "../schemas/openai.js";
import { costMicro } from "./cost.js";

export interface GenerationDraft {
  id: string;
  keyId: string | null;
  appReferer: string | null;
  appTitle: string | null;
  requestedModel: string;
  endpoint: Endpoint | null;
  streamed: boolean;
  finishReason: FinishReason;
  usage: Usage | null;
  latencyMs: number | null;
  ttftMs: number | null;
  attempts: AttemptRecord[];
  error: { code: string; status: number; message: string } | null;
}

export function toRow(draft: GenerationDraft): NewGeneration {
  const usage = draft.usage;
  const endpoint = draft.endpoint;

  // Failed requests are not billed. A cascade that burned three providers
  // before giving up must not charge for any of them.
  //
  // Zero-completion insurance: a generation that produced no output tokens is
  // also free, even though the provider will still charge us for the prompt.
  // The caller got nothing usable, so passing on the input cost would be
  // billing them for our routing decision.
  const producedOutput = (usage?.completion_tokens ?? 0) > 0;
  const billable = endpoint !== null && usage !== null && draft.error === null && producedOutput;

  return {
    id: draft.id,
    keyId: draft.keyId,
    appReferer: draft.appReferer,
    appTitle: draft.appTitle,
    requestedModel: draft.requestedModel,
    modelId: endpoint?.modelId ?? null,
    endpointId: endpoint?.id ?? null,
    provider: endpoint?.provider ?? null,
    streamed: draft.streamed,
    finishReason: draft.finishReason,
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    costMicro: billable ? costMicro(usage, endpoint) : 0,
    latencyMs: draft.latencyMs,
    ttftMs: draft.ttftMs,
    attempts: draft.attempts,
    error: draft.error,
  };
}

/**
 * Persist a generation.
 *
 * Accounting must never be able to fail a request that already succeeded, so
 * callers fire this without awaiting and errors are logged, not thrown.
 */
export async function recordGeneration(db: DB, draft: GenerationDraft): Promise<void> {
  try {
    await db.insert(generations).values(toRow(draft));
  } catch (err) {
    console.error("[crossbar] failed to record generation", draft.id, err);
  }
}
