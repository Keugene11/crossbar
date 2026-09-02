import type { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, AppEnv } from "../app.js";
import { microToUsd } from "../accounting/cost.js";
import { CrossbarError } from "../errors.js";
import { remainingMicro, type IssuedKey } from "../keys/store.js";

const TopUp = z.object({ amount: z.number().positive().max(1_000_000) }).strict();

const CreateKey = z
  .object({
    label: z.string().max(120).optional(),
    /** Credit to grant, in USD. Omit for zero; null for unlimited. */
    credit: z.number().min(0).max(1_000_000).nullable().optional(),
  })
  .strict();

function serialize(k: IssuedKey): Record<string, unknown> {
  const left = remainingMicro(k);
  return {
    id: k.id,
    label: k.label,
    limit: k.creditMicro === null ? null : microToUsd(k.creditMicro),
    usage: microToUsd(k.spentMicro),
    limit_remaining: left === null ? null : microToUsd(left),
    disabled: k.disabled,
  };
}

/**
 * Key management, for whoever runs the gateway.
 *
 * This is what lets crossbar be handed to other people: the operator holds the
 * provider credentials once and issues keys with credit on them, so a user of
 * the gateway never needs an account with Anthropic or OpenAI.
 *
 * Guarded by operator keys only -- an issued key must not be able to mint
 * itself more credit, so a key with a balance is refused here.
 */
export function registerKeyAdminRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const store = () => {
    if (!deps.keys) {
      throw new CrossbarError({
        status: 501,
        code: "not_found",
        message: "This deployment issues no keys; it uses CROSSBAR_API_KEYS from configuration.",
        retryable: false,
      });
    }
    return deps.keys;
  };

  const requireOperator = (c: { get: (k: "creditMicro") => number | null | undefined }): void => {
    // An operator key is unlimited; anything with a balance is a tenant.
    if (c.get("creditMicro") !== null && c.get("creditMicro") !== undefined) {
      throw new CrossbarError({
        status: 403,
        code: "permission",
        message: "Only an operator key may manage keys.",
        retryable: false,
      });
    }
  };

  app.post("/keys", async (c) => {
    requireOperator(c);
    const parsed = CreateKey.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new CrossbarError({
        status: 400,
        code: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid body",
        retryable: false,
      });
    }

    const { credit } = parsed.data;
    const { key, issued } = await store().create({
      ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
      creditMicro: credit === null ? null : Math.round((credit ?? 0) * 1_000_000),
    });

    // The only time the key itself is ever returned; only its hash is stored.
    return c.json({ data: { ...serialize(issued), key } }, 201);
  });

  // Top up an existing key. Separate from creation because a balance is a
  // running account, not something fixed at issue time -- and because "add
  // credit" must never be reachable by the key it is adding credit to.
  app.post("/keys/:id/credit", async (c) => {
    requireOperator(c);
    const parsed = TopUp.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new CrossbarError({
        status: 400,
        code: "invalid_request",
        message: "Body must be { \"amount\": <USD greater than 0> }",
        retryable: false,
      });
    }

    const updated = await store().topUp(
      c.req.param("id"),
      Math.round(parsed.data.amount * 1_000_000),
    );
    if (!updated) {
      throw new CrossbarError({
        status: 404,
        code: "not_found",
        message: `No such key: "${c.req.param("id")}"`,
        retryable: false,
      });
    }
    return c.json({ data: serialize(updated) });
  });

  app.get("/keys", async (c) => {
    requireOperator(c);
    return c.json({ object: "list", data: (await store().list()).map(serialize) });
  });

  app.delete("/keys/:id", async (c) => {
    requireOperator(c);
    const ok = await store().revoke(c.req.param("id"));
    if (!ok) {
      throw new CrossbarError({
        status: 404,
        code: "not_found",
        message: `No such key: "${c.req.param("id")}"`,
        retryable: false,
      });
    }
    return c.json({ data: { id: c.req.param("id"), disabled: true } });
  });

  // Mirrors OpenRouter's /api/v1/credits.
  app.get("/credits", async (c) => {
    const left = c.get("creditMicro");
    const usage = await deps.store.usage(c.get("keyId") ?? null);
    return c.json({
      data: {
        total_credits: left === null || left === undefined ? null : microToUsd(left + usage.costMicro),
        total_usage: microToUsd(usage.costMicro),
        limit_remaining: left === null || left === undefined ? null : microToUsd(left),
      },
    });
  });
}
