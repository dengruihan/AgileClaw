import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { WorktreesListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { serializeSidebarEntry } from "../../app-navigation.ts";
import { resolveSidebarSessionParentKey } from "../../components/app-sidebar-session-parent.ts";
import type { SidebarSessionMutationScope } from "../../components/app-sidebar-session-types.ts";
import { sessionMenuReasons } from "../../components/session-menu-access.ts";
import type { SessionMenuData } from "../../components/session-menu-actions.ts";
import type { SessionActionHost } from "../../components/session-organizer-operations.runtime.ts";
import { t } from "../../i18n/index.ts";
import { openEditor } from "../../lib/editor-links.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../../lib/keyboard-shortcut-contract.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { resolveSessionRenamePatch, resolveSessionRenameValue } from "../../lib/session-rename.ts";
import { collectKnownSessionGroups } from "../../lib/sessions/grouping.ts";
import {
  areUiSessionKeysEquivalent,
  canArchiveSessionRow,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiConversationIdentity,
} from "../../lib/sessions/session-key.ts";
import { runSessionNavigationAction } from "../../lib/sessions/session-menu-navigation.ts";
import { showToast } from "../../lib/toast.ts";
import { runControlUiPluginAction } from "../../plugins/control-ui-actions.ts";
import { ChatPaneContext } from "./chat-pane-context.ts";
import { ChatPaneHeaderMemo } from "./chat-pane-header-memo.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import type { HeaderMenuAction } from "./components/chat-header-session-menu.ts";
import { buildContinueInTerminalCommand } from "./continue-in-terminal-command.ts";

export abstract class ChatPaneSessionMenu extends ChatPaneContext {
  private readonly headerSessionDataMemo = new ChatPaneHeaderMemo<SessionMenuData>();
  protected resolveHeaderSessionTitle(row: GatewaySessionRow | undefined): string {
    // The roster owns accepted titles; pane metadata fills absent cross-agent rows.
    return (
      this.presentationTitle ??
      resolveSessionDisplayName(row?.key ?? this.state?.sessionKey ?? this.sessionKey, row)
    );
  }

  protected canArchiveHeaderSession(row: GatewaySessionRow): boolean {
    return (
      !row.archived &&
      !this.context.sessions.archiveVisibility(row.key) &&
      canArchiveSessionRow(
        row,
        resolveUiConfiguredMainKey({
          agentsList: this.context.agents.state.agentsList,
          hello: this.context.gateway.snapshot.hello,
        }),
      ) &&
      !sessionMenuReasons({ snapshot: this.context.gateway.snapshot, session: row })[
        "toggle-archived"
      ]
    );
  }

  protected readonly handleArchiveSessionShortcut = (event: KeyboardEvent): boolean => {
    if (!matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.archiveSession, event)) {
      return false;
    }
    const state = this.state;
    if (
      event.repeat ||
      event.defaultPrevented ||
      !state?.connected ||
      !this.active ||
      !this.presented ||
      document.openClawModalLayers?.size ||
      document.querySelector(".shell-nav[aria-modal='true']")
    ) {
      return true;
    }
    // The pane's current conversation is authoritative, never sidebar selection.
    const row = selectedChatSessionRow(state);
    if (!row || !this.canArchiveHeaderSession(row)) {
      return true;
    }
    event.preventDefault();
    void this.handleHeaderSessionAction({ kind: "toggle-archived" }, row);
    return true;
  };

  protected headerSessionMenuData(row: GatewaySessionRow, pinnable: boolean): SessionMenuData {
    const mainSessionKey = resolveUiConversationIdentity(
      {
        agentsList: this.context.agents.state.agentsList,
        hello: this.context.gateway.snapshot.hello,
      },
      "main",
      parseAgentSessionKey(row.key)?.agentId ?? row.agentId,
    ).sessionKey;
    const label = this.resolveHeaderSessionTitle(row);
    const isChild = Boolean(resolveSidebarSessionParentKey(row, new Set([mainSessionKey])));
    const archiving = this.context.sessions.archiveVisibility(row.key) === "pending";
    return this.headerSessionDataMemo.read(
      [
        label,
        row.sessionId,
        isChild,
        row.pinned,
        pinnable,
        row.snoozedUntil,
        row.unread,
        row.hiddenFromInvolvingMe,
        row.archived,
        archiving,
        row.category,
        row.icon,
        row.color,
      ],
      () => ({
        label,
        sessionId: row.sessionId ?? null,
        isChild,
        pinned: row.pinned === true,
        pinnable,
        snoozedUntil: row.snoozedUntil ?? null,
        unread: row.unread === true,
        hiddenFromInvolvingMe: row.hiddenFromInvolvingMe,
        archived: row.archived === true,
        archiving,
        category: normalizeOptionalString(row.category) ?? null,
        icon: normalizeOptionalString(row.icon) ?? null,
        color: normalizeOptionalString(row.color) ?? null,
        categoryClearReturnsToGroups: false,
      }),
    );
  }

  private headerSessionOperationsLoad: Promise<
    typeof import("../../components/session-organizer-operations.runtime.ts")
  > | null = null;

  protected async handleHeaderSessionAction(action: HeaderMenuAction, row: GatewaySessionRow) {
    if (action.kind === "stop-cloud-worker") {
      return this.reclaimHeaderPlacement(row);
    }
    if (action.kind === "toggle-archived" && !row.archived && !this.canArchiveHeaderSession(row)) {
      return;
    }
    if (action.kind === "open-in") {
      openEditor(action.editor, action.path);
      return;
    }
    if (action.kind === "rename") {
      await this.renameHeaderSession(row);
      return;
    }
    if (
      action.kind === "copy-session-id" ||
      action.kind === "copy-session-link" ||
      action.kind === "copy-session-preview-link" ||
      action.kind === "copy-markdown" ||
      action.kind === "open-new-tab" ||
      action.kind === "open-new-window" ||
      action.kind === "split-right" ||
      action.kind === "split-below"
    ) {
      const owner = this.headerOutcomeOwner;
      await runSessionNavigationAction(action.kind, {
        context: this.context,
        session: row,
        agentId: this.state ? resolveChatAgentId(this.state) : row.agentId,
        sourceSessionKey: row.key,
        isCurrent: () => this.ownsHeaderOutcome(owner),
      });
      return;
    }
    if (action.kind === "continue-in-terminal") {
      this.openContinueInTerminalDialog(row);
      return;
    }
    const scope = this.captureHeaderSessionActionScope();
    if (!scope) {
      this.publishHeaderError(t("sessionsView.actionRequiresConnection"));
      return;
    }
    const owner = this.headerOutcomeOwner;
    if (action.kind === "plugin") {
      const current = this.state ? selectedChatSessionRow(this.state) : undefined;
      try {
        await runControlUiPluginAction({
          runtime: this.context.plugins,
          id: action.id,
          placement: "session",
          sessionKey: row.key,
          agentId: row.agentId,
          session:
            current?.key === row.key && current.sessionId === row.sessionId ? current : undefined,
          signal: scope.signal,
        });
      } catch (error) {
        this.publishHeaderError(error, owner);
      }
      return;
    }
    const toActionSession = (candidate: GatewaySessionRow) => ({
      key: candidate.key,
      sessionId: candidate.sessionId,
      sharingRole: candidate.sharingRole,
      label: this.resolveHeaderSessionTitle(candidate),
      pinned: candidate.pinned === true,
      unread: candidate.unread === true,
      archived: candidate.archived === true,
      category: candidate.category,
      active: true,
      hasActiveRun: candidate.hasActiveRun ?? candidate.status === "running",
      gatewayHasActiveRun: candidate.hasActiveRun,
    });
    const session = toActionSession(row);
    // Refresh metadata only on the selected instance; replacements must keep
    // the captured ID so the Gateway rejects the stale action. No-ID rows
    // still need current-list presence before a metadata patch can create them.
    const resolveCurrentSession = (notify = false) => {
      const currentRow = scope.sessions.state.result?.sessions.find(
        (candidate) =>
          areUiSessionKeysEquivalent(candidate.key, row.key) &&
          (!session.sessionId || candidate.sessionId === session.sessionId),
      );
      const resolvedRow = currentRow ?? (session.sessionId ? row : null);
      if (!resolvedRow && notify) {
        showToast({ message: t("common.refresh") });
      }
      return resolvedRow ? toActionSession(resolvedRow) : null;
    };
    try {
      const operations = await (this.headerSessionOperationsLoad ??=
        import("../../components/session-organizer-operations.runtime.ts"));
      const host: SessionActionHost & { knownSessionGroups(): string[] } = {
        sessionData: {
          isSessionMutationScopeCurrent: (candidate) =>
            this.isHeaderSessionActionCurrent(candidate, owner),
          publishSessionMutationError: (candidate, error) => {
            if (this.isHeaderSessionActionCurrent(candidate, owner)) {
              this.publishHeaderError(error, owner);
            }
          },
          refreshSidebarSessions: async (agentId) => {
            const outcome = await scope.sessions.reconcileMutation(agentId);
            if (outcome.status === "failed" && this.isHeaderSessionActionCurrent(scope, owner)) {
              this.publishHeaderError(outcome.error, owner);
            }
          },
        },
        pruneSidebarSessionEntry: (key) => {
          const entry = serializeSidebarEntry({ type: "session", key });
          const sidebarEntries = scope.context.navigation.snapshot.sidebarEntries.filter(
            (candidate) => candidate !== entry,
          );
          scope.context.navigation.update({ sidebarEntries });
        },
        selectSession: (key) => this.onPaneSessionChange?.(this.paneId, key),
        sidebarSessionStatusFilter: () => "active",
        knownSessionGroups: () =>
          collectKnownSessionGroups(
            scope.sessions.state.groups,
            scope.sessions.state.result?.sessions ?? [],
          ),
      };
      switch (action.kind) {
        case "toggle-involving-me":
          await operations.setSessionInvolvement(host, session, !row.hiddenFromInvolvingMe, scope);
          break;
        case "toggle-pin":
        case "toggle-unread":
        case "set-icon":
        case "set-color":
        case "reset-appearance": {
          const currentSession = resolveCurrentSession(true);
          if (currentSession) {
            const patch =
              action.kind === "toggle-pin"
                ? { pinned: !currentSession.pinned }
                : action.kind === "toggle-unread"
                  ? { unread: !currentSession.unread }
                  : action.kind === "set-icon"
                    ? { icon: action.icon }
                    : action.kind === "set-color"
                      ? { color: action.color }
                      : { icon: null, color: null };
            await operations.patchSession(
              host,
              currentSession,
              patch,
              scope,
              action.kind === "toggle-pin" ? { sessionScope: true } : undefined,
            );
          }
          break;
        }
        case "assign-owner":
          await operations.assignSessionOwner(host, session, action.owner, scope);
          break;
        case "fork":
          await operations.forkSession(host, session, scope);
          break;
        case "move-to-group":
          await operations.assignSessionCategory(
            host,
            session,
            action.category,
            scope,
            {},
            {
              resolveSession: resolveCurrentSession,
            },
          );
          break;
        case "new-group": {
          const { showInputDialog } = await import("../../components/input-dialog.ts");
          const name = await showInputDialog({
            title: t("sessionsView.newGroupTitle"),
            label: t("sessionsView.newGroupPrompt"),
            submitLabel: t("sessionsView.newGroupCreate"),
            requireValue: true,
          });
          if (name && this.isHeaderSessionActionCurrent(scope, owner)) {
            await operations.assignSessionCategory(
              host,
              session,
              name,
              scope,
              {},
              { resolveSession: resolveCurrentSession },
            );
          }
          break;
        }
        case "snooze":
          await operations.snoozeSessionWithUndo(host, session, action.snoozedUntil, scope);
          break;
        case "wake":
          await operations.patchSession(host, session, { snoozedUntil: null }, scope, {
            sessionScope: true,
          });
          break;
        case "toggle-archived":
          if (session.archived) {
            await operations.patchSession(host, session, { archived: false }, scope, {
              sessionScope: true,
            });
          } else {
            await operations.archiveSessionWithUndo(host, session, scope);
          }
          break;
        case "delete":
          await operations.deleteSession(host, session, scope);
          break;
        default:
          action satisfies never;
      }
    } catch (error) {
      if (this.isHeaderSessionActionCurrent(scope, owner)) {
        this.publishHeaderError(error, owner);
      }
    }
  }

  private resolveContinueInTerminalCommand(row: GatewaySessionRow, client: GatewayBrowserClient) {
    return buildContinueInTerminalCommand({
      gatewayUrl: client.gatewayUrl,
      sessionKey: row.key,
      rowAgentId: row.agentId,
      selectedAgentId: this.context.agentSelection.state.selectedId ?? undefined,
    });
  }

  protected continueInTerminalDisabledReason(row: GatewaySessionRow): string | undefined {
    const gateway = this.context.gateway;
    const client = gateway.snapshot.client;
    if (gateway.snapshot.phase !== "connected" || !client) {
      return t("chat.sessionHeader.continueInTerminal.disconnected");
    }
    const result = this.resolveContinueInTerminalCommand(row, client);
    if (result.ok) {
      return undefined;
    }
    return t(
      result.reason === "query-routed"
        ? "chat.sessionHeader.continueInTerminal.queryRouted"
        : "chat.sessionHeader.continueInTerminal.unavailable",
    );
  }

  private openContinueInTerminalDialog(row: GatewaySessionRow): void {
    const scope = this.captureConnectionScope();
    if (!scope) {
      return;
    }
    const result = this.resolveContinueInTerminalCommand(row, scope.client);
    if (!result.ok) {
      return;
    }
    this.continueInTerminalDialog = {
      qualifiedSessionKey: result.qualifiedSessionKey,
      selectedGatewayUrl: this.context.gateway.connection.gatewayUrl,
      clientGatewayUrl: scope.client.gatewayUrl,
      scope,
    };
    this.requestUpdate();
  }

  protected closeContinueInTerminalDialog(): void {
    if (!this.continueInTerminalDialog) {
      return;
    }
    this.continueInTerminalDialog = null;
    this.requestUpdate();
  }

  protected currentContinueInTerminalCommand(row: GatewaySessionRow | undefined): string | null {
    const dialog = this.continueInTerminalDialog;
    const gateway = this.context.gateway;
    const client = gateway.snapshot.client;
    if (!dialog) {
      return null;
    }
    const result = row && client ? this.resolveContinueInTerminalCommand(row, client) : null;
    if (
      !this.isConnectionScopeCurrent(dialog.scope) ||
      !result?.ok ||
      result.qualifiedSessionKey !== dialog.qualifiedSessionKey ||
      gateway.connection.gatewayUrl !== dialog.selectedGatewayUrl ||
      client?.gatewayUrl !== dialog.clientGatewayUrl
    ) {
      this.continueInTerminalDialog = null;
      return null;
    }
    return result.command;
  }

  private captureHeaderSessionActionScope():
    | (SidebarSessionMutationScope & { signal: AbortSignal })
    | null {
    const gateway = this.context.gateway;
    const client = gateway.snapshot.client;
    if (gateway.snapshot.phase !== "connected" || !client) {
      return null;
    }
    return {
      epoch: this.connectionGeneration,
      context: this.context,
      gateway,
      sessions: this.context.sessions,
      client,
      selectedAgentId: this.context.agentSelection.state.selectedId ?? "main",
      signal: this.headerSessionMutationAbortController.signal,
    };
  }

  private isHeaderSessionActionCurrent(scope: SidebarSessionMutationScope, owner: string): boolean {
    return (
      this.ownsHeaderOutcome(owner) &&
      this.isConnected &&
      this.context === scope.context &&
      this.context.gateway === scope.gateway &&
      this.context.sessions === scope.sessions &&
      scope.gateway.snapshot.phase === "connected" &&
      scope.gateway.snapshot.client === scope.client
    );
  }

  /** Shares the sidebar/sessions-page dialog rename: the pane header has no
   * inline title editor, so the menu action edits through a modal tied to the
   * connection scope and revalidates access against the current row before
   * patching. */
  protected async renameHeaderSession(row: GatewaySessionRow): Promise<void> {
    const scope = this.captureHeaderSessionActionScope();
    if (!scope) {
      this.publishHeaderError(t("sessionsView.actionRequiresConnection"));
      return;
    }
    const access = readSessionMethodAccess(this.context.gateway.snapshot, {
      method: "sessions.patch",
      params: { key: row.key, label: null },
      sessionScope: true,
      session: row,
    });
    if (!access.allowed) {
      this.publishHeaderError(access.reason);
      return;
    }
    const initialValue = resolveSessionRenameValue(row);
    const { showInputDialog } = await import("../../components/input-dialog.ts");
    const value = await showInputDialog({
      signal: scope.signal,
      title: t("sessionsView.renameSessionPrompt"),
      defaultValue: initialValue,
    });
    const patch = value === null ? null : resolveSessionRenamePatch(value, initialValue, row.label);
    const state = this.state;
    if (value === null || !patch || !state || scope.signal.aborted) {
      return;
    }
    // Refresh metadata only on the selected instance; a replacement that kept
    // the captured ID stays patchable, matching the organizer's rename.
    const currentRow = state.sessionsResult?.sessions.find(
      (candidate) =>
        areUiSessionKeysEquivalent(candidate.key, row.key) &&
        (!row.sessionId || candidate.sessionId === row.sessionId),
    );
    const commitAccess = readSessionMethodAccess(this.context.gateway.snapshot, {
      method: "sessions.patch",
      params: { key: row.key, ...patch },
      sessionScope: true,
      session: currentRow ?? row,
    });
    if (!commitAccess.allowed) {
      this.publishHeaderError(commitAccess.reason);
      return;
    }
    const owner = this.headerOutcomeOwner;
    void this.context.sessions
      .patch(row.key, patch, {
        agentId: resolveChatAgentId(state),
        expectedSessionId: row.sessionId,
      })
      .catch((error: unknown) => this.publishHeaderError(error, owner));
  }

  protected async loadHeaderMenuData(row: GatewaySessionRow): Promise<void> {
    const client = this.connectedClient;
    if (!client) {
      return;
    }
    const loads: Promise<unknown>[] = [];
    // Same precedence as resolveChatPaneWorkspace/loadSessionFileRoot: the
    // worktree checkout path feeds the session menu's open-in actions.
    const immediateRoot =
      (row.execNode ? row.execCwd?.trim() : undefined) ||
      row.spawnedWorkspaceDir?.trim() ||
      row.spawnedCwd?.trim() ||
      null;
    const worktreeId = row.worktree?.id;
    if (worktreeId && !immediateRoot) {
      const entry = this.headerWorktreePaths.get(worktreeId) ?? {};
      this.headerWorktreePaths.set(worktreeId, entry);
      if (!entry.loaded && !entry.loading) {
        entry.loading = true;
        loads.push(
          client
            .request<WorktreesListResult>("worktrees.list", {})
            .then((result) => {
              entry.path =
                result.worktrees.find(
                  (candidate) => candidate.id === worktreeId && candidate.removedAt === undefined,
                )?.path ?? null;
              entry.loaded = true;
            })
            .catch(() => {
              entry.path = null;
              entry.loaded = false;
            })
            .finally(() => {
              entry.loading = false;
            }),
        );
      }
    }
    await Promise.all(loads);
    this.requestUpdate();
  }

  protected publishHeaderError(error: unknown, owner = this.headerOutcomeOwner): void {
    if (!this.state || !this.ownsHeaderOutcome(owner)) {
      return;
    }
    this.state.chatError = this.state.lastError = formatUiError(error);
    this.state.requestUpdate?.();
  }
}
