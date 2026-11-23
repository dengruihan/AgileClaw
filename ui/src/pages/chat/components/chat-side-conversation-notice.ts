import { t } from "../../../i18n/index.ts";

/**
 * Bounded merge outcomes translate; a Gateway error (conflict, archived parent,
 * preserved checkout) stays verbatim so the row and the child strip say why.
 */
export function sideConversationNoticeText(notice: string | undefined): string | undefined {
  if (!notice) {
    return undefined;
  }
  if (notice === "merged" || notice === "already-merged" || notice === "merged-no-commit") {
    return t(`chat.rail.notice.${notice}`);
  }
  return notice;
}
