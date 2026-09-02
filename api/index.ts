import { bootstrapStateless } from "../apps/gateway/src/bootstrap.js";

export const config = { runtime: "nodejs" };

/**
 * Serverless entrypoint.
 *
 * Exports Web-standard `Request -> Response` handlers, which the Node runtime
 * supports directly -- no framework adapter in between, so streaming responses
 * pass through untouched.
 *
 * Bootstrapping is memoised per instance rather than per request: a cold start
 * pays for it once and every warm invocation reuses it. Stateless by
 * construction, since there is no writable disk here for an embedded database
 * and no connection worth pooling.
 */
let cached: Promise<Awaited<ReturnType<typeof bootstrapStateless>>> | undefined;

async function dispatch(request: Request): Promise<Response> {
  cached ??= bootstrapStateless();
  const { app } = await cached;
  return app.fetch(request);
}

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
export const HEAD = dispatch;
export const OPTIONS = dispatch;
