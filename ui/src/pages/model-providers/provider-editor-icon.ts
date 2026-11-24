// Provider editor icon wiring: the draft edits a committed name or a manual
// picker choice applies. This lives outside provider-manager.ts, whose line
// budget is already exhausted.
import {
  applyProviderIconChoice,
  applyProviderNameIcon,
  type ProviderIconChoice,
} from "../../components/provider-brand-rules.ts";

export type ProviderNameDraftUpdate = {
  draft: Record<string, unknown>;
  /** Trimmed name the editor should show. */
  name: string;
  /** Leaves to mark touched: `displayName` plus any automatic icon change. */
  changedFields: readonly string[];
};

/**
 * Applies a committed Name field to a provider draft, including the automatic
 * brand icon the new name matches. Manual icon choices stay untouched.
 */
export function applyProviderNameToEditor(
  draft: Readonly<Record<string, unknown>>,
  typed: string,
): ProviderNameDraftUpdate {
  const name = typed.trim();
  const named = { ...draft };
  if (name) {
    named.displayName = name;
  } else {
    // A cleared name is not a value: dropping the leaf restores the derived label.
    delete named.displayName;
  }
  const iconUpdate = applyProviderNameIcon(named, name);
  return {
    draft: iconUpdate.draft,
    name,
    changedFields: ["displayName", ...iconUpdate.changedFields],
  };
}

/**
 * Applies a picker choice to the editor draft and records its changed leaves.
 * Returns null when the choice changes nothing.
 */
export function applyProviderIconChoiceToEditor(
  draft: Readonly<Record<string, unknown>>,
  choice: ProviderIconChoice,
  touched: Set<string>,
): Record<string, unknown> | null {
  const update = applyProviderIconChoice(draft, choice);
  if (!update.changed) {
    return null;
  }
  for (const field of update.changedFields) {
    touched.add(field);
  }
  return update.draft;
}
