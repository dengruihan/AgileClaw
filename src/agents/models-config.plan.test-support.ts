import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { planOpenClawModelsJson, type PreparedModelsConfigContext } from "./models-config.plan.js";

type PreparedPlanParams = Parameters<typeof planOpenClawModelsJson>[0];
type FlatPreparedContext = Omit<
  PreparedModelsConfigContext,
  "discoveryAuthConfig" | "sourceConfigForSecrets" | "envFingerprint"
> & {
  discoveryAuthConfig?: OpenClawConfig;
  sourceConfigForSecrets?: OpenClawConfig;
};
type PlanParams = Omit<PreparedPlanParams, "context" | "existingRaw"> &
  FlatPreparedContext & {
    existingRaw?: string;
    // Accepted for caller compatibility; the API-key-only plan no longer consumes these.
    authStore?: AuthProfileStore;
    pluginCatalogs?: unknown;
    existingParsed?: unknown;
  };

export function planModelsJsonForTest(params: PlanParams) {
  const {
    authStore: _authStore,
    existingParsed: _existingParsed,
    pluginCatalogs: _pluginCatalogs,
    existingRaw = "",
    ...contextParams
  } = params;
  return planOpenClawModelsJson({
    context: {
      ...contextParams,
      discoveryAuthConfig: params.discoveryAuthConfig ?? params.cfg,
      sourceConfigForSecrets: params.sourceConfigForSecrets ?? params.cfg,
      envFingerprint: params.env,
    },
    existingRaw,
  });
}
