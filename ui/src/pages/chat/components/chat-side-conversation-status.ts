import "../../../styles/chat/side-conversation.css";
import { html, nothing, type TemplateResult } from "lit";
import type { SideConversationRowMarker } from "../../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../../i18n/index.ts";
import type { SideConversationSummary } from "../../../lib/chat/side-conversations.ts";

export type SideConversationStatusProps = {
  marker: SideConversationRowMarker;
  summary: SideConversationSummary | undefined;
  modelLabel: string | undefined;
  modelInherited: boolean;
  connected: boolean;
  pending: boolean;
  onClose?: () => void;
  onReopen?: () => void;
  onMerge?: () => void;
  onAbandon?: () => void;
};

function worktreeLine(summary: SideConversationSummary | undefined): string {
  if (summary?.worktree) {
    return t("chat.sideConversation.worktree", { branch: summary.worktree.branch });
  }
  if (summary?.worktreeSkipped === "not-git") {
    return t("chat.sideConversation.notGit");
  }
  if (summary?.worktreeSkipped === "remote-exec") {
    return t("chat.sideConversation.remoteWorkspace");
  }
  return t("chat.sideConversation.sharedWorkspace");
}

/**
 * Header strip for a hidden side-conversation child. The child is a real chat
 * pane, so pane model/thinking controls patch only this session; the strip names
 * the inherited source and the worktree facts the child actually owns.
 */
export function renderSideConversationStatus(
  props: SideConversationStatusProps,
): TemplateResult | typeof nothing {
  const state = props.summary?.state ?? props.marker.state;
  const canClose = state === "open" && props.onClose;
  const canReopen = state === "closed" && props.onReopen;
  const canMerge =
    Boolean(props.summary?.worktree) &&
    state !== "merged" &&
    state !== "abandoned" &&
    props.onMerge;
  const canAbandon = (state === "open" || state === "closed") && props.onAbandon;
  return html`
    <div
      class="chat-side-conversation-status"
      role="region"
      aria-label=${t("chat.sideConversation.statusLabel")}
      data-side-conversation-state=${state}
    >
      <span class="chat-side-conversation-status__title">
        ${t("chat.sideConversation.title", { ordinal: String(props.marker.ordinal) })}
      </span>
      <span
        class="chat-side-conversation-status__state chat-side-conversation-status__state--${state}"
        >${t(`chat.sideConversation.${state}`)}</span
      >
      <span class="chat-side-conversation-status__worktree">${worktreeLine(props.summary)}</span>
      ${
        props.modelLabel
          ? html`<span class="chat-side-conversation-status__model"
              >${t(
                props.modelInherited
                  ? "chat.sideConversation.inheritedModel"
                  : "chat.sideConversation.ownModel",
                { model: props.modelLabel },
              )}</span
            >`
          : nothing
      }
      <span class="chat-side-conversation-status__actions">
        ${
          canClose
            ? html`<button
                class="btn btn--sm"
                type="button"
                ?disabled=${props.pending || !props.connected}
                @click=${props.onClose}
              >
                ${t("chat.sideConversation.close")}
              </button>`
            : nothing
        }
        ${
          canReopen
            ? html`<button
                class="btn btn--sm"
                type="button"
                ?disabled=${props.pending || !props.connected}
                @click=${props.onReopen}
              >
                ${t("chat.sideConversation.reopen")}
              </button>`
            : nothing
        }
        ${
          canMerge
            ? html`<button
                class="btn btn--sm"
                type="button"
                ?disabled=${props.pending || !props.connected}
                @click=${props.onMerge}
              >
                ${t("chat.sideConversation.merge")}
              </button>`
            : nothing
        }
        ${
          canAbandon
            ? html`<button
                class="btn btn--sm"
                type="button"
                ?disabled=${props.pending || !props.connected}
                @click=${props.onAbandon}
              >
                ${t("chat.sideConversation.abandon")}
              </button>`
            : nothing
        }
      </span>
    </div>
  `;
}
