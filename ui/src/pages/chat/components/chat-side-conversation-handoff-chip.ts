import "../../../styles/chat/side-conversation.css";
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";

export type SideConversationHandoffChipProps = {
  count: number;
  connected: boolean;
  pending: boolean;
  onCancel: () => void;
};

/**
 * Parent composer chip for pending next-message handoffs. Cancel reopens the
 * newest closed child through the Gateway's existing reopen transition; no
 * review, merge, or run is started from here.
 */
export function renderSideConversationHandoffChip(props: SideConversationHandoffChipProps) {
  if (props.count <= 0) {
    return nothing;
  }
  return html`
    <div
      class="chat-side-conversation-handoff"
      role="status"
      data-side-conversation-handoff-count=${String(props.count)}
    >
      <span class="chat-side-conversation-handoff__label"
        >${t(
          props.count === 1
            ? "chat.sideConversation.handoffChip"
            : "chat.sideConversation.handoffChipPlural",
          { count: String(props.count) },
        )}</span
      >
      <button
        class="btn btn--sm"
        type="button"
        ?disabled=${!props.connected || props.pending}
        @click=${props.onCancel}
      >
        ${t(
          props.pending
            ? "chat.sideConversation.handoffCancelPending"
            : "chat.sideConversation.handoffCancel",
        )}
      </button>
    </div>
  `;
}
