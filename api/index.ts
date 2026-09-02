import { handle } from "hono/vercel";
import { bootstrapStateless } from "../apps/gateway/src/bootstrap.js";

export const config = { runtime: "nodejs" };

/**
 * Serverless entrypoint.
 *
 * Bootstrapping is memoised per instance rather than per request: a cold start
 * pays for it once and every warm invocation reuses it. Stateless by
 * construction -- there is no writable disk here for an embedded database, and
 * no connection worth pooling, so the catalog is compiled in and the ledger
 * lives in memory for the life of the instance.
 */
let cached: Promise<Awaited<ReturnType<typeof bootstrapStateless>>> | undefined;

function instance() {
  cached ??= bootstrapStateless();
  return cached;
}

async function dispatch(req: Request): Promise<Response> {
  const { app } = await instance();
  return app.fetch(req);
}

const handler = handle({ fetch: dispatch } as never);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export default handler;
