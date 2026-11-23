import { nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
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
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import { formatChatSelectionAnnotation } from "./components/chat-selection-attachment.ts";
import { sideConversationNoticeText } from "./components/chat-side-conversation-notice.ts";
import { renderSideConversationStatus } from "./components/chat-side-conversation-status.ts";
import { dispatchSideConversationOpen } from "./side-conversation-events.ts";
import { ChatSideConversations, sideConversationsFor } from "./side-conversations-controller.ts";
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
  protected sideChatFocusGeneration = 0;
  private sideChatPresented = false;
  protected sideChatFocusRequest?: () => boolean;
  /**
   * The Gateway connection owns one registry per parent; every pane bound to
   * the same client reads and observes that same view. The pane keeps only the
   * rail compose state and its subscription lifetime.
   */
  private sideConversationStore: ChatSideConversations | null = null;
  private sideConversationStoreClient: GatewayBrowserClient | null = null;
  private sideConversationStoreCleanup: (() => void) | null = null;
  private sideConversationSubmitPending = false;
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

  protected syncSideChatPresentation(presented: boolean): void {
    if (
      this.sideChatPresented === presented &&
      (presented || this.sideChatFocusRequest === undefined)
    ) {
      return;
    }
    this.sideChatPresented = presented;
    if (presented && this.state) {
      this.sideChatFocusRequest ??= this.captureSideChatFocus(this.state).requestFocus;
    } else {
      this.sideChatFocusGeneration += 1;
      this.sideChatFocusRequest = undefined;
    }
  }

  private captureSideChatFocus(pageState: ChatPageHost) {
    const sessionKey = pageState.sessionKey;
    const agentId = resolveChatAgentId(pageState);
    const generation = this.connectionGeneration;
    const focusGeneration = this.sideChatFocusGeneration;
    const composer = getChatComposerState(this.presentationId);
    const editRevision = composer.editRevision;
    const draft = pageState.chatMessage;
    const ownsFocus = () =>
      this.state === pageState &&
      pageState.sessionKey === sessionKey &&
      resolveChatAgentId(pageState) === agentId &&
      this.connectionGeneration === generation &&
      this.sideChatFocusGeneration === focusGeneration &&
      composer.editRevision === editRevision &&
      pageState.chatMessage === draft &&
      this.sideChatPresented &&
      (this.ownerDocument.activeElement === this.ownerDocument.body ||
        this.contains(this.ownerDocument.activeElement)) &&
      this.isConnected &&
      this.active &&
      this.visuallyPresented &&
      this.presented;
    const requestFocus = () => {
      if (this.sideChatFocusRequest === requestFocus) {
        this.sideChatFocusRequest = undefined;
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

  private bindSideConversations(client: GatewayBrowserClient): ChatSideConversations {
    if (this.sideConversationStore && this.sideConversationStoreClient === client) {
      return this.sideConversationStore;
    }
    this.sideConversationStoreCleanup?.();
    const store = sideConversationsFor(client);
    this.sideConversationStoreClient = client;
    this.sideConversationStore = store;
    this.sideConversationStoreCleanup = store.subscribe(() => this.requestUpdate());
    return store;
  }

  override disconnectedCallback() {
    this.sideConversationStoreCleanup?.();
    this.sideConversationStoreCleanup = null;
    this.sideConversationStore = null;
    this.sideConversationStoreClient = null;
    super.disconnectedCallback();
  }

  protected sideConversationsView() {
    const parent = this.sideConversationParent();
    return parent
      ? this.sideConversationStore?.view(parent.parentSessionKey, parent.agentId)
      : undefined;
  }

  /**
   * Loads the parent's registry when this pane's connection, parent, or visible
   * rail changes. Mutations refresh the shared entry directly. Retained but
   * unpresented panes stay quiet so parking one never schedules background reads.
   */
  protected syncSideConversations(): void {
    const state = this.state;
    const parent = this.sideConversationParent();
    if (!state?.connected || !state.client || !parent || !this.presented) {
      return;
    }
    const railVisible = isSidebarSlotVisible(state.sidebarLayout, "companion");
    const child = isSideConversationSessionKey(state.sessionKey);
    // A parent pane reads its registry only for the open rail; a presented child
    // pane always reads it, so every split pane shows the current state strip.
    if (!railVisible && !child) {
      return;
    }
    const row = selectedChatSessionRow(state);
    const key = JSON.stringify([
      this.connectionGeneration,
      parent.parentSessionKey,
      parent.agentId ?? "",
      row?.sideConversationCount ?? 0,
      row?.handoffCount ?? 0,
      row?.sideConversation?.state ?? "",
      row?.sideConversation?.updatedAt ?? 0,
      railVisible,
    ]);
    if (key === this.sideConversationSyncKey) {
      return;
    }
    this.sideConversationSyncKey = key;
    void this.bindSideConversations(state.client).load(
      parent.parentSessionKey,
      state.client,
      parent.agentId,
      { connectionKey: String(this.connectionGeneration) },
    );
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
    void this.bindSideConversations(state.client).load(
      parent.parentSessionKey,
      state.client,
      parent.agentId,
      { force: true, connectionKey: String(this.connectionGeneration) },
    );
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
      notice: sideConversationNoticeText(view?.notices.get(state.sessionKey)),
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
      const store = this.bindSideConversations(state.client);
      await store.load(parent.parentSessionKey, state.client, parent.agentId, {
        force: true,
        connectionKey: String(this.connectionGeneration),
      });
      const latest = latestClosedSideConversation(
        store.view(parent.parentSessionKey, parent.agentId)?.conversations ?? [],
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
    const { ownsFocus, requestFocus } = this.captureSideChatFocus(pageState);
    this.sideChatFocusRequest = requestFocus;
    this.requestUpdate();
    await this.submitSideConversationQuestion(question);
    if (ownsFocus()) {
      this.sideChatFocusRequest = requestFocus;
      this.requestUpdate();
    }
  }

  protected readonly submitSideConversationQuestion = async (question: string): Promise<void> => {
    const state = this.state;
    const parent = this.sideConversationParent();
    const text = question.trim();
    // Creation owns a worktree and can take a while; one submit at a time keeps
    // a double Enter or double click from creating two children.
    if (!state?.connected || !state.client || !parent || this.sideConversationSubmitPending) {
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
    this.sideConversationSubmitPending = true;
    this.requestUpdate();
    try {
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
      }
    } finally {
      this.sideConversationSubmitPending = false;
      this.requestUpdate();
    }
  };

  protected sideConversationSubmitting(): boolean {
    return this.sideConversationSubmitPending;
  }

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
      return await this.bindSideConversations(state.client).create({
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
      await this.bindSideConversations(state.client)[action]({
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
