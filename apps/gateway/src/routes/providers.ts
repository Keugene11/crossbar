import type { Hono } from "hono";
import type { AppDeps, AppEnv } from "../app.js";

/**
 * Provider directory, mirroring OpenRouter's `/api/v1/providers`.
 *
 * Exists so a caller can decide whether a provider is acceptable *before*
 * sending a prompt to it -- the data-retention field in particular is what
 * `provider.data_collection: "deny"` filters on, and a routing control the
 * caller cannot inspect is not much of a control.
 */
export function registerProviderRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  app.get("/providers", async (c) => {
    const snapshot = await deps.catalog.ensureFresh();
    const rows = snapshot.providers;

    // Endpoint counts come from the live catalog, so a provider with every
    // endpoint disabled is visibly serving nothing.
    const endpointCount = new Map<string, number>();
    const modelIds = new Map<string, Set<string>>();
    for (const e of snapshot.byEndpointId.values()) {
      endpointCount.set(e.provider, (endpointCount.get(e.provider) ?? 0) + 1);
      (modelIds.get(e.provider) ?? modelIds.set(e.provider, new Set()).get(e.provider)!).add(
        e.modelId,
      );
    }

    return c.json({
      object: "list",
      data: rows.map((p) => ({
          id: p.id,
          name: p.name,
          may_train_on_data: p.mayTrainOnData,
          privacy_policy_url: p.privacyPolicyUrl,
          terms_of_service_url: p.termsUrl,
          status_page_url: p.statusPageUrl,
          endpoint_count: endpointCount.get(p.id) ?? 0,
          model_count: modelIds.get(p.id)?.size ?? 0,
        adapter_registered: deps.providers.has(p.id),
      })),
    });
  });
}
