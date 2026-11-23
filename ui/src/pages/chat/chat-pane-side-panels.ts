import { nothing, type TemplateResult } from "lit";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  isSideConversationSessionKey,
  latestClosedSideConversation,
  type SideConversationSummary,
} from "../../lib/chat/side-conversations.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { showToast } from "../../lib/toast.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "../../lib/uploads.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import { sendSessionObserverVisibility } from "./chat-observer.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import { requestChatSend } from "./chat-send-request.ts";
import { ChatSessionCompanionThreads } from "./chat-session-companion.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import { formatChatSelectionAnnotation } from "./components/chat-selection-attachment.ts";
import { renderSideConversationStatus } from "./components/chat-side-conversation-status.ts";
import { dispatchSideConversationOpen } from "./side-conversation-events.ts";
import { ChatSideConversations } from "./side-conversations-controller.ts";
import type { SidebarLayout } from "./sidebar-layout-types.ts";
import {
  closeSlot,
  isSidebarSlotVisible,
  openSlot,
  promoteSidebarPanel,
  setSidebarOpen,
  sidebarMainPanel,
} from "./sidebar-layout.ts";

export abstract class ChatPaneSidePanels extends ChatPaneBase {
  protected sessionCompanionFocusGeneration = 0;
  private sessionCompanionPresented = false;
  protected sessionCompanionFocusRequest?: () => boolean;
  /**
   * The pane owns the parent's cached side-conversation list and the rail's
   * compose state. The Gateway owns membership and every lifecycle transition.
   */
  protected readonly sideConversations = new ChatSideConversations(() => {
    this.requestUpdate();
  });
  // Legacy companion threads stay instantiated for their retire/clear hooks;
  // M205 retires the module once no shipped path references it.
  protected readonly sessionCompanionThreads = new ChatSessionCompanionThreads(() => {
    this.requestUpdate();
  });
  protected sideConversationDraft = "";
  protected sideConversationAttachments: ChatAttachment[] = [];
  protected readonly sideConversationAttachmentReads = new ChatAttachmentReadLifecycle(() =>
    this.requestUpdate(),
  );
  private sideConversationSyncKey = "";
  private sideConversationHandoffPending = false;
  protected readonly setSessionObserverVisibility = (visible: boolean) => {
    const state = this.state;
    if (state?.connected && state.client) {
      void sendSessionObserverVisibility(state.client, visible).catch(() => undefined);
    }
    this.requestUpdate();
  };

  protected restorePaneSidebarLayout(layout: SidebarLayout): SidebarLayout {
    if (!this.compact) {
      return layout;
    }
    // Home's visibility consumers share the restored Chat-first layout;
    // the saved full-page task layout stays intact.
    const conversation = layout.columns[0]?.panels.find((panel) => panel.slot === "conversation");
    const restored = conversation ? promoteSidebarPanel(layout, conversation.id) : layout;
    return { ...restored, open: false, expanded: false };
  }

  protected setChatSidePanelOpen(open: boolean, layout?: SidebarLayout): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const renderedLayout = layout ?? state.sidebarLayout;
    const nextLayout = setSidebarOpen(renderedLayout, open);
    if (renderedLayout.columns[0]?.panels.some((panel) => panel.slot === "companion")) {
      this.setSessionObserverVisibility(isSidebarSlotVisible(nextLayout, "companion"));
    }
    this.commitSidebarLayout(
      nextLayout,
      sidebarMainPanel(renderedLayout)?.slot === "dashboard"
        ? { dashboardPresentation: "personal" }
        : undefined,
    );
  }

  protected requestSessionRail(intent: "open" | "toggle"): void {
    const state = this.state;
    if (!state) {
      return;
    }
    if (intent === "toggle" && isSidebarSlotVisible(state.sidebarLayout, "companion")) {
      this.commitSidebarLayout(closeSlot(state.sidebarLayout, "companion"));
      this.setSessionObserverVisibility(false);
      return;
    }
    this.commitSidebarLayout(openSlot(state.sidebarLayout, "companion"));
    this.setSessionObserverVisibility(true);
    // Opening the rail is a read request for the parent's current registry.
    this.requestUpdate();
  }

  requestSubagentsPanel(intent: "open" | "toggle"): void {
    this.requestBackgroundPanel("subagents", intent);
  }

  protected requestBackgroundPanel(
    slot: "subagents" | "processes",
    intent: "open" | "toggle",
  ): void {
    const state = this.state;
    if (!state) {
      return;
    }
    this.commitSidebarLayout(
      intent === "toggle" && isSidebarSlotVisible(state.sidebarLayout, slot)
        ? closeSlot(state.sidebarLayout, slot)
        : openSlot(state.sidebarLayout, slot),
    );
  }

  protected syncSessionCompanionPresentation(presented: boolean): void {
    if (
      this.sessionCompanionPresented === presented &&
      (presented || this.sessionCompanionFocusRequest === undefined)
    ) {
      return;
    }
    this.sessionCompanionPresented = presented;
    if (presented && this.state) {
      this.sessionCompanionFocusRequest ??= this.captureSessionCompanionFocus(
        this.state,
      ).requestFocus;
    } else {
      this.sessionCompanionFocusGeneration += 1;
      this.sessionCompanionFocusRequest = undefined;
    }
  }

  private captureSessionCompanionFocus(pageState: ChatPageHost) {
    const sessionKey = pageState.sessionKey;
    const agentId = resolveChatAgentId(pageState);
    const generation = this.connectionGeneration;
    const focusGeneration = this.sessionCompanionFocusGeneration;
    const composer = getChatComposerState(this.presentationId);
    const editRevision = composer.editRevision;
    const draft = pageState.chatMessage;
    const ownsFocus = () =>
      this.state === pageState &&
      pageState.sessionKey === sessionKey &&
      resolveChatAgentId(pageState) === agentId &&
      this.connectionGeneration === generation &&
      this.sessionCompanionFocusGeneration === focusGeneration &&
      composer.editRevision === editRevision &&
      pageState.chatMessage === draft &&
      this.sessionCompanionPresented &&
      (this.ownerDocument.activeElement === this.ownerDocument.body ||
        this.contains(this.ownerDocument.activeElement)) &&
      this.isConnected &&
      this.active &&
      this.visuallyPresented &&
      this.presented;
    const requestFocus = () => {
      if (this.sessionCompanionFocusRequest === requestFocus) {
        this.sessionCompanionFocusRequest = undefined;
        this.requestUpdate();
      }
      return ownsFocus();
    };
    return { ownsFocus, requestFocus };
  }

  /** The parent whose registry this pane shows: its own session, or a child's parent. */
  protected sideConversationParent(): { parentSessionKey: string; agentId?: string } | undefined {
    const state = this.state;
    if (!state?.sessionKey || parseCatalogSessionKey(state.sessionKey)) {
      return undefined;
    }
    const agentId = resolveChatAgentId(state) ?? undefined;
    const childParent = selectedChatSessionRow(state)?.sideConversation?.parentSessionKey?.trim();
    if (childParent) {
      return { parentSessionKey: childParent, ...(agentId ? { agentId } : {}) };
    }
    // A child marker arrives with its startup read; never treat the child as a parent.
    if (isSideConversationSessionKey(state.sessionKey)) {
      return undefined;
    }
    return { parentSessionKey: state.sessionKey.trim(), ...(agentId ? { agentId } : {}) };
  }

  protected sideConversationsView() {
    const parent = this.sideConversationParent();
    return parent
      ? this.sideConversations.view(parent.parentSessionKey, parent.agentId)
      : undefined;
  }

  /**
   * Loads the parent's registry when this pane's connection, parent, or visible
   * rail changes. Mutations refresh the cached entry directly. Hidden panes stay
   * quiet so parking a retained pane never schedules background reads.
   */
  protected syncSideConversations(): void {
    const state = this.state;
    const parent = this.sideConversationParent();
    if (!state?.connected || !state.client || !parent || !this.presented) {
      return;
    }
    const railVisible = isSidebarSlotVisible(state.sidebarLayout, "companion");
    if (!this.active && !railVisible) {
      return;
    }
    // A parent pane reads its registry only for the open rail; a hidden child
    // pane needs no list until it becomes active.
    if (!railVisible && !isSideConversationSessionKey(state.sessionKey)) {
      return;
    }
    const row = selectedChatSessionRow(state);
    const key = JSON.stringify([
      this.connectionGeneration,
      parent.parentSessionKey,
      parent.agentId ?? "",
      row?.sideConversationCount ?? 0,
      row?.handoffCount ?? 0,
      railVisible,
    ]);
    if (key === this.sideConversationSyncKey) {
      return;
    }
    this.sideConversationSyncKey = key;
    void this.sideConversations.load(parent.parentSessionKey, state.client, parent.agentId, {
      connectionKey: String(this.connectionGeneration),
    });
  }

  protected refreshSideConversations(sessionKey?: string): void {
    const state = this.state;
    const parent = this.sideConversationParent();
    if (!state?.connected || !state.client || !parent) {
      return;
    }
    if (sessionKey && parent.parentSessionKey !== sessionKey) {
      return;
    }
    void this.sideConversations.load(parent.parentSessionKey, state.client, parent.agentId, {
      force: true,
      connectionKey: String(this.connectionGeneration),
    });
  }

  /** Parent composer chip: how many closed children will ride the next user turn. */
  protected sideConversationHandoffCount(): number {
    const state = this.state;
    return state ? (selectedChatSessionRow(state)?.handoffCount ?? 0) : 0;
  }

  protected sideConversationHandoffProps():
    | { count: number; connected: boolean; pending: boolean; onCancel: () => void }
    | undefined {
    const state = this.state;
    const count = this.sideConversationHandoffCount();
    if (!state || count <= 0) {
      return undefined;
    }
    return {
      count,
      connected: state.connected,
      pending: this.sideConversationHandoffPending,
      onCancel: () => void this.cancelSideConversationHandoff(),
    };
  }

  /** Side-conversation children carry their own status strip above the transcript. */
  protected renderSideConversationStatusFor(state: ChatPageHost): TemplateResult | typeof nothing {
    const row = selectedChatSessionRow(state);
    const marker = row?.sideConversation;
    if (!marker) {
      return nothing;
    }
    const view = this.sideConversationsView();
    const summary = view?.conversations.find(
      (conversation) => conversation.sessionKey === state.sessionKey,
    );
    const provider = row?.modelProvider?.trim() || summary?.modelProvider?.trim();
    const model = row?.model?.trim() || summary?.model?.trim();
    const modelLabel = model ? (provider ? `${provider}/${model}` : model) : undefined;
    return renderSideConversationStatus({
      marker,
      summary,
      modelLabel,
      modelInherited: row?.modelOverrideSource === "inherited",
      connected: state.connected,
      pending: view?.pendingSessionKeys.has(state.sessionKey) === true,
      ...(summary
        ? {
            onClose: () => this.closeSideConversation(summary),
            onReopen: () => this.reopenSideConversation(summary),
            onMerge: () => this.mergeSideConversation(summary),
            onAbandon: () => this.abandonSideConversation(summary),
          }
        : {}),
    });
  }

  /**
   * Reopen the newest closed child to withdraw its pending reminder. Reopen is
   * the Gateway's existing cancellation semantics; nothing runs automatically.
   */
  protected readonly cancelSideConversationHandoff = async (): Promise<void> => {
    const state = this.state;
    const parent = this.sideConversationParent();
    if (!state?.connected || !state.client || !parent) {
      return;
    }
    this.sideConversationHandoffPending = true;
    this.requestUpdate();
    try {
      await this.sideConversations.load(parent.parentSessionKey, state.client, parent.agentId, {
        force: true,
        connectionKey: String(this.connectionGeneration),
      });
      const latest = latestClosedSideConversation(
        this.sideConversations.view(parent.parentSessionKey, parent.agentId)?.conversations ?? [],
      );
      if (!latest) {
        return;
      }
      await this.transitionSideConversation(latest, "reopen");
    } finally {
      this.sideConversationHandoffPending = false;
      this.requestUpdate();
    }
  };

  protected async openSideConversation(pageState: ChatPageHost, question: string): Promise<void> {
    const { ownsFocus, requestFocus } = this.captureSessionCompanionFocus(pageState);
    this.sessionCompanionFocusRequest = requestFocus;
    this.requestUpdate();
    await this.submitSideConversationQuestion(question);
    if (ownsFocus()) {
      this.sessionCompanionFocusRequest = requestFocus;
      this.requestUpdate();
    }
  }

  protected readonly submitSideConversationQuestion = async (question: string): Promise<void> => {
    const state = this.state;
    const parent = this.sideConversationParent();
    const text = question.trim();
    if (!state?.connected || !state.client || !parent) {
      return;
    }
    const attachments = this.sideConversationAttachments;
    if (
      attachments.some((attachment) => !attachment.selectionAnnotation) &&
      !uploadsEnabled(state.uploadConfig)
    ) {
      showToast({ message: uploadsDisabledMessage() });
      return;
    }
    const conversation = await this.createSideConversation(parent);
    if (!conversation) {
      return;
    }
    // The child pane takes over; keep its exact key and let chat.send admit to the child.
    this.sideConversationDraft = "";
    this.sideConversationAttachments = [];
    dispatchSideConversationOpen({
      parentSessionKey: parent.parentSessionKey,
      childSessionKey: conversation.sessionKey,
      // An empty /side or /btw opens the child composer instead of sending.
      ...(text ? {} : { draft: "" }),
      ...(parent.agentId ? { agentId: parent.agentId } : {}),
    });
    this.requestUpdate();
    if (!text) {
      return;
    }
    try {
      await requestChatSend(state, {
        message: text,
        sessionKey: conversation.sessionKey,
        ...(parent.agentId ? { agentId: parent.agentId } : {}),
        runId: generateUUID(),
        ...(attachments.length ? { attachments } : {}),
      });
      releaseChatAttachmentPayloads(attachments);
    } catch (error) {
      showToast({ message: t("chat.rail.sendFailed", { error: formatUiError(error) }) });
      // The child stays open; its own composer owns the retry.
      this.requestUpdate();
    }
  };

  /**
   * Selection entry: open a child pane with the quoted passage as its draft.
   * The question is typed in the child composer, so nothing enters the parent queue.
   */
  protected readonly stageSideConversationSelection = (
    attachment: ChatAttachment,
    sourceSessionKey: string,
  ): boolean => {
    const state = this.state;
    const parent = this.sideConversationParent();
    const annotation = attachment.selectionAnnotation;
    if (
      !state?.connected ||
      !state.client ||
      !parent ||
      !annotation ||
      state.sessionKey !== sourceSessionKey
    ) {
      return false;
    }
    void (async () => {
      const conversation = await this.createSideConversation(parent);
      if (!conversation) {
        return;
      }
      dispatchSideConversationOpen({
        parentSessionKey: parent.parentSessionKey,
        childSessionKey: conversation.sessionKey,
        draft: formatChatSelectionAnnotation(annotation),
        ...(parent.agentId ? { agentId: parent.agentId } : {}),
      });
    })();
    return true;
  };

  protected readonly onSideConversationDraftChange = (draft: string): void => {
    this.sideConversationDraft = draft;
    this.requestUpdate();
  };

  protected readonly onSideConversationAttachmentsChange = (
    attachments: ChatAttachment[],
  ): boolean => {
    this.sideConversationAttachments = attachments;
    this.requestUpdate();
    return true;
  };

  private async createSideConversation(parent: {
    parentSessionKey: string;
    agentId?: string;
  }): Promise<SideConversationSummary | undefined> {
    const state = this.state;
    if (!state?.connected || !state.client) {
      return undefined;
    }
    try {
      return await this.sideConversations.create({
        parentSessionKey: parent.parentSessionKey,
        client: state.client,
        agentId: parent.agentId,
      });
    } catch (error) {
      showToast({ message: t("chat.rail.createFailed", { error: formatUiError(error) }) });
      return undefined;
    }
  }

  protected readonly openSideConversationPane = (conversation: SideConversationSummary): void => {
    const parent = this.sideConversationParent();
    if (!parent) {
      return;
    }
    dispatchSideConversationOpen({
      parentSessionKey: parent.parentSessionKey,
      childSessionKey: conversation.sessionKey,
      ...(parent.agentId ? { agentId: parent.agentId } : {}),
    });
  };

  protected readonly closeSideConversation = (conversation: SideConversationSummary): void => {
    void this.transitionSideConversation(conversation, "close");
  };

  protected readonly reopenSideConversation = (conversation: SideConversationSummary): void => {
    void this.transitionSideConversation(conversation, "reopen");
  };

  protected readonly mergeSideConversation = (conversation: SideConversationSummary): void => {
    if (!conversation.worktree) {
      return;
    }
    void showConfirmDialog({
      message: t("chat.sideConversation.mergeConfirm", {
        branch: conversation.worktree.branch,
      }),
      confirmLabel: t("chat.sideConversation.merge"),
    }).then((confirmed) => {
      if (confirmed) {
        void this.transitionSideConversation(conversation, "merge");
      }
    });
  };

  protected readonly abandonSideConversation = (conversation: SideConversationSummary): void => {
    void showConfirmDialog({
      message: t("chat.sideConversation.abandonConfirm"),
      confirmLabel: t("chat.sideConversation.abandon"),
      danger: true,
    }).then((confirmed) => {
      if (confirmed) {
        void this.transitionSideConversation(conversation, "abandon");
      }
    });
  };

  private async transitionSideConversation(
    conversation: SideConversationSummary,
    action: "close" | "reopen" | "merge" | "abandon",
  ): Promise<void> {
    const state = this.state;
    const parent = this.sideConversationParent();
    if (!state?.connected || !state.client || !parent) {
      return;
    }
    try {
      await this.sideConversations[action]({
        client: state.client,
        parentSessionKey: parent.parentSessionKey,
        sessionKey: conversation.sessionKey,
        agentId: parent.agentId,
      });
    } catch (error) {
      if (action === "merge") {
        // Merge conflicts and preserved checkouts stay visible on their own row.
        return;
      }
      showToast({
        message: t("chat.rail.transitionFailed", { error: formatUiError(error) }),
      });
    }
  }
}
