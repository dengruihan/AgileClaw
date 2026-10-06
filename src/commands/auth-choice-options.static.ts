// Static auth-choice option definitions used before provider manifests are loaded.
import type { AuthChoice, AuthChoiceGroupId } from "./onboard-types.js";

export type AuthChoiceOption = {
  value: AuthChoice;
  label: string;
  hint?: string;
  providerId?: string;
  groupId?: AuthChoiceGroupId;
  groupLabel?: string;
  groupHint?: string;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only" | "detected-only";
  modelTarget?: "utility";
  onboardingFeatured?: boolean;
};

export type AuthChoiceGroup = {
  value: AuthChoiceGroupId;
  label: string;
  hint?: string;
  methodMessage?: string;
  providerIds?: string[];
  options: AuthChoiceOption[];
};

export const CORE_AUTH_CHOICE_OPTIONS: ReadonlyArray<AuthChoiceOption> = [
  {
    value: "custom-api-key",
    label: "Custom Provider",
    hint: "Any OpenAI or Anthropic compatible endpoint",
    groupId: "custom",
    groupLabel: "Custom Provider",
    groupHint: "Any OpenAI or Anthropic compatible endpoint",
  },
];

/**
 * API-key auth choice that `--token-provider` binds to a concrete provider.
 */
export const GENERIC_PROVIDER_AUTH_CHOICES: ReadonlyArray<AuthChoice> = ["apiKey"];

/** Format static auth-choice values for Commander help/validation text. */
export function formatStaticAuthChoiceChoicesForCli(): string {
  return [
    ...CORE_AUTH_CHOICE_OPTIONS.map((opt) => opt.value),
    ...GENERIC_PROVIDER_AUTH_CHOICES,
    "skip",
  ].join("|");
}
