import { configFieldId } from "../../components/config-form.shared.ts";
import type { ConfigRouteData } from "../config/route-data.ts";

function targetsConfigPath(target: string | null, path: string[]): boolean {
  const prefix = configFieldId(path, "").slice(0, -1);
  return Boolean(target && (target.startsWith(`${prefix}-`) || target.startsWith(`${prefix}_`)));
}

/** Resolve saved schema links through their canonical field IDs, without decoding dynamic keys. */
export function providerRouteIntent(
  route: ConfigRouteData | null | undefined,
  providerIds: string[] = [],
): { provider: string | null; view: "settings" | "models" } | null {
  if (!route) {
    return null;
  }
  const search = new URLSearchParams(route.search);
  const view = search.get("view") === "models" ? "models" : "settings";
  if (
    search.get("subsection") === "providers" ||
    ["settings", "models"].includes(search.get("view") ?? "")
  ) {
    return { provider: search.get("provider")?.trim() || null, view };
  }
  for (const provider of providerIds) {
    const section = `models.providers.${provider}`;
    if (
      route.section === section ||
      route.section?.startsWith(`${section}.`) ||
      targetsConfigPath(route.targetBlockId, ["models", "providers", provider])
    ) {
      return {
        provider,
        view:
          route.section?.startsWith(`${section}.models`) ||
          targetsConfigPath(route.targetBlockId, ["models", "providers", provider, "models"])
            ? "models"
            : "settings",
      };
    }
  }
  return route.section === "models.providers" ||
    route.section?.startsWith("models.providers.") ||
    targetsConfigPath(route.targetBlockId, ["models", "providers"]) ||
    route.targetBlockId === "settings-model-providers"
    ? { provider: null, view }
    : null;
}
