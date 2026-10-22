import type {
  ModelAuthStatusResult,
  ProviderLoginOption,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import { providerDisplayLabel } from "../../components/provider-icon.ts";
import { t } from "../../i18n/index.ts";

type LoginChoice = Omit<ProviderLoginOption, "kind"> & {
  kind: ProviderLoginOption["kind"] | "setup-secret";
};

type LoginProvider = {
  id: string;
  label: string;
  choices: LoginChoice[];
  authProviders: string[];
  apiKeyProvider?: string;
};

/**
 * Login-option ids are `pluginId/choiceId` refs; setup-discovery surfaces the
 * same choices under their bare choice id. Normalize before comparing.
 */
export function loginOptionChoiceId(option: Pick<ProviderLoginOption, "id">): string {
  return decodeURIComponent(option.id.split("/").pop() ?? option.id);
}

export function buildLoginProviders({
  providers,
  authStatus,
  allowQuickApiKey,
  manualProviders,
}: {
  providers?: string[];
  authStatus?: ModelAuthStatusResult | null;
  allowQuickApiKey: boolean;
  manualProviders?: SystemAgentSetupDetectResult["manualProviders"];
}): LoginProvider[] {
  const groups = new Map<string, LoginProvider>();
  const choices = new Set<string>();
  const choiceGroups = new Map<string, string>();
  // When the caller wires the manual setup section, a paste-a-key login option
  // duplicates its verify-and-use entry for the same choice; browser sign-in
  // methods stay — they are a different operation, not a duplicate.
  const manualSecretChoiceIds = new Set((manualProviders ?? []).map((option) => option.id));
  for (const capability of authStatus?.providerCapabilities ?? []) {
    if (providers && !providers.includes(capability.provider)) {
      continue;
    }
    for (const option of capability.loginOptions ?? []) {
      const groupId = option.groupId ?? option.brandId;
      choiceGroups.set(loginOptionChoiceId(option), groupId);
      if (option.kind === "secret" && manualSecretChoiceIds.has(loginOptionChoiceId(option))) {
        continue;
      }
      let group = groups.get(groupId);
      if (!group) {
        group = { id: groupId, label: "", choices: [], authProviders: [] };
        groups.set(group.id, group);
      }
      group.label ||= option.groupLabel?.trim() ?? "";
      if (!group.authProviders.includes(capability.provider)) {
        group.authProviders.push(capability.provider);
      }
      if (!choices.has(option.id)) {
        choices.add(option.id);
        group.choices.push(option);
      }
    }
    // Quick-key support is independent of wizard choices. Keep the exact
    // capability owner for the key form even when its login brand is an alias.
    if (capability.quickApiKeySetup && allowQuickApiKey) {
      const brands = capability.loginOptions?.length
        ? capability.loginOptions.map((option) => option.groupId ?? option.brandId)
        : [capability.provider];
      for (const id of new Set(brands)) {
        const group = groups.get(id) ?? { id, label: "", choices: [], authProviders: [] };
        if (!group.authProviders.includes(capability.provider)) {
          group.authProviders.push(capability.provider);
        }
        groups.set(id, { ...group, apiKeyProvider: group.apiKeyProvider ?? capability.provider });
      }
    }
  }
  if (manualProviders) {
    for (const option of manualProviders) {
      const authProvider = option.brandId ?? option.id;
      const id = choiceGroups.get(option.id) ?? authProvider;
      if (choices.has(option.id) || (providers && !providers.includes(authProvider))) {
        continue;
      }
      const group = groups.get(id) ?? { id, label: "", choices: [], authProviders: [] };
      group.label ||= option.groupLabel?.trim() || option.label;
      if (!group.authProviders.includes(authProvider)) {
        group.authProviders.push(authProvider);
      }
      const duplicateLabel = group.choices.some((choice) => choice.label === option.label);
      group.choices.push({
        ...option,
        brandId: authProvider,
        kind: "setup-secret",
        featured: false,
        ...(duplicateLabel
          ? {
              label: t("modelSetup.manual.accessValueFor", { provider: option.label }),
              hint: t("modelSetup.manual.accessValuePlaceholder"),
            }
          : {}),
      });
      choices.add(option.id);
      groups.set(id, group);
    }
  }
  for (const group of groups.values()) {
    group.label ||= providerDisplayLabel(group.id);
  }
  return [...groups.values()].toSorted(
    (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
}
