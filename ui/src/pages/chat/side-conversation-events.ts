import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";

/**
 * Pane-to-page request for opening one side-conversation child as a real split
 * pane. The chat page owns layout, routing, and persistence; a pane only names
 * the parent it belongs to and the hidden child the Gateway already created.
 */
export const SIDE_CONVERSATION_OPEN_EVENT = "openclaw:side-conversation-open";

export type SideConversationOpenDetail = {
  parentSessionKey: string;
  childSessionKey: string;
  /** One-shot composer draft for the child pane, for example a quoted selection. */
  draft?: string;
  agentId?: string;
};

export function dispatchSideConversationOpen(detail: SideConversationOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent<SideConversationOpenDetail>(SIDE_CONVERSATION_OPEN_EVENT, { detail }),
  );
}

/** A page-level listener accepts only requests for the parent it is showing. */
export function sideConversationOpenMatchesParent(
  detail: SideConversationOpenDetail,
  parentSessionKey: string,
): boolean {
  return areUiSessionKeysEquivalent(detail.parentSessionKey, parentSessionKey);
}
