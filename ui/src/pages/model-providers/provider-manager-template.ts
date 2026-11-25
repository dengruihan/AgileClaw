// Template drafts for the provider create flow. A create intent that names a
// curated template prefills the editor from packages/model-catalog-core facts;
// the template id itself never reaches the config write, only its endpoint,
// headers, and models do.
import {
  PROVIDER_TEMPLATES,
  type ProviderTemplate,
} from "@openclaw/model-catalog-core/provider-templates";
import { i18n } from "../../i18n/index.ts";
import { providerCreateEntry } from "./provider-model-config.ts";
import { localizedTemplateName } from "./provider-template-picker.ts";

/** Create-intent fields this module reads; the manager's intent type extends it. */
export type ProviderTemplateIntent = {
  view: "settings" | "models" | "create";
  templateId?: string;
};

/** The curated row an intent names; an unknown or absent id is not a template. */
export function providerTemplate(templateId: string | undefined): ProviderTemplate | undefined {
  return templateId ? PROVIDER_TEMPLATES.find((template) => template.id === templateId) : undefined;
}

/**
 * Draft state for a template create: the display facts plus the template's
 * endpoint and models. `providerCreated` stops the template from re-seeding the
 * entry that the first write already stored.
 */
export function providerTemplateSeed(
  intent: ProviderTemplateIntent | null | undefined,
  providerCreated: boolean,
): Record<string, unknown> | null {
  const template =
    intent?.view === "create" && !providerCreated ? providerTemplate(intent.templateId) : undefined;
  if (!template) {
    return null;
  }
  const { baseUrl, api, headers, models } = template.provider;
  return {
    displayName: localizedTemplateName(template.name, i18n.getLocale()),
    // The template icon is written without `iconManual`, so a later rename still
    // recomputes the icon through the brand rules.
    icon: template.icon,
    baseUrl,
    api,
    ...(headers ? { headers: structuredClone(headers) } : {}),
    models: structuredClone(models),
  };
}

/**
 * Create-write inputs for an editor draft. A template contributes its key seed
 * only while the draft still targets the template endpoint, so a rewritten base
 * URL never inherits another provider's key name.
 */
export function providerCreateInput(
  draft: Record<string, unknown>,
  intent: ProviderTemplateIntent | null | undefined,
): { entry: Record<string, unknown>; keySeed?: string } {
  const template = intent?.view === "create" ? providerTemplate(intent.templateId) : undefined;
  if (!template?.keySeed || draft.baseUrl !== template.provider.baseUrl) {
    return { entry: providerCreateEntry(draft) };
  }
  return { entry: providerCreateEntry(draft), keySeed: template.keySeed };
}
