import "../../../styles/chat/session-rail.css";
import "./chat-comment-controller.ts";
import { html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import type { SessionObserverDigest } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import type { ChatSendShortcut } from "../../../app/settings.ts";
import { icons } from "../../../components/icons.ts";
import { renderPanelEmptyState } from "../../../components/panel-empty-state.ts";
import { renderPanelLoadingSkeleton } from "../../../components/panel-loading-skeleton.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import type { SideConversationSummary } from "../../../lib/chat/side-conversations.ts";
import { formatTimeMs } from "../../../lib/format.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
import type { SideConversationsView } from "../side-conversations-controller.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import type { ChatAttachmentReadLifecycle } from "./chat-attachment-reads.ts";
import { createChatAttachmentDropHandlers } from "./chat-attachments.ts";
import {
  createSessionRailComposer,
  sessionRailQuestion,
  renderSessionRailComposer,
} from "./chat-session-rail-composer.ts";
import { sideConversationNoticeText } from "./chat-side-conversation-notice.ts";

function checksSummary(pullRequest: ControlUiSessionPullRequest): string | null {
  const checks = pullRequest.checks;
  if (!checks) {
    return null;
  }
  if (checks.state === "passing") {
    return t("chat.rail.checksPassing", { count: String(checks.passed) });
  }
  if (checks.state === "failing") {
    return t("chat.rail.checksFailing", { count: String(checks.failed) });
  }
  return t("chat.rail.checksPending", { count: String(checks.running) });
}

const SESSION_RAIL_STARTER_KEYS = ["changed", "stopped", "remaining"] as const;

function conversationWorktreeLabel(conversation: SideConversationSummary): string {
  if (conversation.worktree) {
    return t("chat.rail.worktree", { branch: conversation.worktree.branch });
  }
  if (conversation.worktreeSkipped === "not-git") {
    return t("chat.rail.notGit");
  }
  if (conversation.worktreeSkipped === "remote-exec") {
    return t("chat.rail.remoteWorkspace");
  }
  return t("chat.rail.sharedWorkspace");
}

export class ChatSessionRailElement extends OpenClawLightDomElement {
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) digest: SessionObserverDigest | null = null;
  @property({ attribute: false }) running = false;
  @property({ attribute: false }) activeRunId: string | null = null;
  @property({ attribute: false }) pullRequests: ControlUiSessionPullRequest[] = [];
  @property({ attribute: false }) sideConversations?: SideConversationsView;
  @property({ attribute: false }) draft = "";
  @property({ attribute: false }) attachments: ChatAttachment[] = [];
  @property({ attribute: false }) attachmentReads?: ChatAttachmentReadLifecycle;
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) sendShortcut: ChatSendShortcut = "enter";
  @property({ attribute: false }) onSubmit?: (question: string) => void;
  @property({ attribute: false }) onDraftChange?: (draft: string) => void;
  @property({ attribute: false })
  onAttachmentsChange?: ChatAttachmentControlsProps["onAttachmentsChange"];
  @property({ attribute: false }) onOpenConversation?: (
    conversation: SideConversationSummary,
  ) => void;
  @property({ attribute: false })
  onCloseConversation?: (conversation: SideConversationSummary) => void;
  @property({ attribute: false })
  onReopenConversation?: (conversation: SideConversationSummary) => void;
  @property({ attribute: false })
  onMergeConversation?: (conversation: SideConversationSummary) => void;
  @property({ attribute: false })
  onAbandonConversation?: (conversation: SideConversationSummary) => void;
  @property({ attribute: false })
  attachmentLimits?: ChatAttachmentControlsProps["attachmentLimits"];
  @property({ attribute: false })
  uploadConfig?: ChatAttachmentControlsProps["uploadConfig"];
  @property({ type: Boolean }) submitting = false;
  @property({ type: Boolean }) presented = false;
  @property({ attribute: false }) focusRequest?: () => boolean;

  constructor() {
    super();
    new SubscriptionsController(this).watchStore(() => this.uploadConfig);
  }
  private readonly composer = createSessionRailComposer({
    submit: () => this.submit(),
    onDraftChange: (draft) => this.onDraftChange?.(draft),
    sendShortcut: () => this.sendShortcut,
  });

  override disconnectedCallback() {
    this.composer.dispose();
    super.disconnectedCallback();
  }

  override updated(changedProperties: PropertyValues<this>) {
    // The pane owns focus intent across lazy mounting and retained tab presentation.
    const focusRequested = changedProperties.has("focusRequest")
      ? this.focusRequest?.()
      : undefined;
    if (this.presented && focusRequested) {
      this.querySelector<HTMLTextAreaElement>(".chat-session-rail__input:not(:disabled)")?.focus({
        preventScroll: true,
      });
    }
  }

  private submit() {
    const question = sessionRailQuestion({ draft: this.draft, attachments: this.attachments });
    if (
      question &&
      this.connected &&
      !this.submitting &&
      !this.attachmentReads?.pendingReads &&
      this.onSubmit
    ) {
      this.onSubmit(question);
    }
  }

  private renderPullRequests() {
    const pullRequests = this.pullRequests.slice(0, 2);
    if (pullRequests.length === 0) {
      return nothing;
    }
    return html`
      <div class="chat-session-rail__prs" aria-label=${t("chat.rail.pullRequests")}>
        ${pullRequests.map((pullRequest) => {
          const checks = checksSummary(pullRequest);
          return html`
            <a
              class="chat-session-rail__pr"
              href=${pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              title=${pullRequest.title}
            >
              <span>#${pullRequest.number}</span>
              <span>${t(`chat.pullRequests.${pullRequest.state}`)}</span>
              ${
                checks ? html`<span class="chat-session-rail__pr-checks">${checks}</span>` : nothing
              }
            </a>
          `;
        })}
      </div>
    `;
  }

  private renderStarters() {
    return html`
      <div class="chat-session-rail__starters">
        ${SESSION_RAIL_STARTER_KEYS.map((key) => {
          const question = t(`chat.rail.starters.${key}`);
          return html`
            <button
              class="chip chat-session-rail__starter"
              type="button"
              ?disabled=${!this.connected || this.submitting}
              @click=${() => this.onSubmit?.(question)}
            >
              ${icons.spark}<span>${question}</span>
            </button>
          `;
        })}
      </div>
    `;
  }

  private noticeText(notice: string | undefined) {
    const text = sideConversationNoticeText(notice);
    return text ? html`<p class="chat-session-rail__notice" role="status">${text}</p>` : nothing;
  }

  private renderConversation(conversation: SideConversationSummary) {
    const view = this.sideConversations;
    const pending = view?.pendingSessionKeys.has(conversation.sessionKey) === true;
    const notice = view?.notices.get(conversation.sessionKey);
    const state = conversation.state;
    const canClose = state === "open";
    const canReopen = state === "closed";
    const canMerge =
      conversation.worktree !== undefined && state !== "merged" && state !== "abandoned";
    const canAbandon = state === "open" || state === "closed";
    const title =
      conversation.title?.trim() ||
      t("chat.rail.conversationTitle", {
        ordinal: String(conversation.ordinal),
      });
    return html`
      <article
        class="chat-session-rail__conversation"
        data-side-conversation-key=${conversation.sessionKey}
      >
        <button
          class="chat-session-rail__conversation-main"
          type="button"
          ?disabled=${!this.connected || !this.onOpenConversation}
          @click=${() => this.onOpenConversation?.(conversation)}
        >
          <span class="chat-session-rail__conversation-title">${title}</span>
          <span
            class="chat-session-rail__state chat-session-rail__state--${state}"
            data-side-conversation-state=${state}
            >${t(`chat.rail.state.${state}`)}</span
          >
          <span class="chat-session-rail__worktree"
            >${conversationWorktreeLabel(conversation)}</span
          >
          <time
            class="chat-session-rail__timestamp"
            datetime=${new Date(conversation.updatedAt).toISOString()}
            >${t("chat.rail.updated", {
              time: formatTimeMs(
                conversation.updatedAt,
                { hour: "numeric", minute: "2-digit" },
                "",
              ),
            })}</time
          >
        </button>
        <div class="chat-session-rail__conversation-actions">
          ${
            canClose
              ? html`<button
                  class="btn btn--sm"
                  type="button"
                  ?disabled=${pending || !this.connected}
                  @click=${() => this.onCloseConversation?.(conversation)}
                >
                  ${t("chat.rail.closeConversation")}
                </button>`
              : nothing
          }
          ${
            canReopen
              ? html`<button
                  class="btn btn--sm"
                  type="button"
                  ?disabled=${pending || !this.connected}
                  @click=${() => this.onReopenConversation?.(conversation)}
                >
                  ${t("chat.rail.reopenConversation")}
                </button>`
              : nothing
          }
          ${
            canMerge
              ? html`<button
                  class="btn btn--sm"
                  type="button"
                  ?disabled=${pending || !this.connected}
                  @click=${() => this.onMergeConversation?.(conversation)}
                >
                  ${t("chat.rail.mergeConversation")}
                </button>`
              : nothing
          }
          ${
            canAbandon
              ? html`<button
                  class="btn btn--sm"
                  type="button"
                  ?disabled=${pending || !this.connected}
                  @click=${() => this.onAbandonConversation?.(conversation)}
                >
                  ${t("chat.rail.abandonConversation")}
                </button>`
              : nothing
          }
        </div>
        ${this.noticeText(notice)}
      </article>
    `;
  }

  private renderConversations() {
    const view = this.sideConversations;
    if (!view && !this.connected) {
      return nothing;
    }
    const conversations = view?.conversations ?? [];
    return html`
      <div
        class="chat-session-rail__list"
        aria-live="polite"
        aria-label=${t("chat.rail.listLabel")}
      >
        ${
          view?.loading && conversations.length === 0
            ? renderPanelLoadingSkeleton("chat", t("chat.rail.loading"))
            : nothing
        }
        ${
          view?.error && conversations.length === 0
            ? html`<div class="callout danger" role="alert">${view.error}</div>`
            : nothing
        }
        ${
          view && !view.loading && conversations.length === 0
            ? renderPanelEmptyState({
                icon: icons.bot,
                heading: t("chat.sidePanel.companion"),
                description: t("chat.rail.empty"),
              })
            : nothing
        }
        ${conversations.map((conversation) => this.renderConversation(conversation))}
        ${
          view?.cleanupPendingCount
            ? html`<p class="chat-session-rail__notice" role="status">
                ${t("chat.rail.cleanupPending", { count: String(view.cleanupPendingCount) })}
              </p>`
            : nothing
        }
      </div>
    `;
  }

  override render() {
    this.composer.syncDraft(this.draft);
    const reads = this.attachmentReads;
    const readSignal = reads?.readSignal;
    const attachmentProps: ChatAttachmentControlsProps = {
      uploadConfig: this.uploadConfig,
      attachments: this.attachments,
      getAttachments: () => this.attachments,
      attachmentReads: reads,
      readSignal,
      attachmentLimits: this.attachmentLimits,
      selectionContextOnly: true,
      imagesOnly: true,
      disabled: !this.connected,
      onAttachmentsChange: this.onAttachmentsChange,
      onPendingReadsChange: (delta) => {
        if (readSignal) {
          reads?.updatePending(readSignal, delta);
        }
      },
    };
    const drop = createChatAttachmentDropHandlers({
      ...attachmentProps,
      canCompose: this.connected,
    });
    const pending = reads?.pendingReads ?? 0;
    const showPullRequests =
      this.digest &&
      (!this.running || (this.activeRunId && this.digest.runId === this.activeRunId));
    return html`
      <section
        class="chat-session-rail chat-session-rail--expanded chat-session-rail--embedded"
        role="region"
        aria-label=${t("chat.rail.title")}
        tabindex="-1"
        @dragenter=${drop.onDragenter}
        @dragleave=${drop.onDragleave}
        @dragover=${drop.onDragover}
        @drop=${drop.onDrop}
      >
        ${showPullRequests ? this.renderPullRequests() : nothing} ${this.renderConversations()}
        ${(this.sideConversations?.conversations.length ?? 0) === 0 ? this.renderStarters() : nothing}
        <openclaw-chat-comment-controller
          .paneId=${`side-chat:${this.sessionKey}`}
          .props=${attachmentProps}
          .disabled=${attachmentProps.disabled}
          .sessionKey=${this.sessionKey}
          .presented=${this.presented}
        ></openclaw-chat-comment-controller>
        ${renderSessionRailComposer({
          state: { draft: this.draft, attachments: this.attachments },
          connected: this.connected,
          pending: pending > 0 || this.submitting,
          sendShortcut: this.sendShortcut,
          composer: this.composer,
          attachmentProps,
          submit: () => this.submit(),
        })}
      </section>
    `;
  }
}

if (!customElements.get("openclaw-chat-session-rail")) {
  customElements.define("openclaw-chat-session-rail", ChatSessionRailElement);
}
