import type {
  SideConversationSummary,
  SideConversationsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  requestSideConversationAbandon,
  requestSideConversationClose,
  requestSideConversationCreate,
  requestSideConversationList,
  requestSideConversationMerge,
  requestSideConversationReopen,
  sideConversationIntentId,
  sortSideConversations,
} from "../../lib/chat/side-conversations.ts";
import { formatUiError } from "../../lib/format-error.ts";

export type SideConversationsView = {
  parentSessionKey: string;
  agentId?: string;
  loading: boolean;
  error: string | null;
  conversations: SideConversationSummary[];
  cleanupPendingCount: number;
  /** Children with a lifecycle write in flight; their row actions stay disabled. */
  pendingSessionKeys: ReadonlySet<string>;
  /** Latest visible outcome for one child, for example a merge conflict or preserved worktree. */
  notices: ReadonlyMap<string, string>;
};

type ParentEntry = {
  conversations: SideConversationSummary[];
  cleanupPendingCount: number;
  loading: boolean;
  error: string | null;
  token: symbol | null;
  connectionKey: string | null;
  pending: Set<string>;
  notices: Map<string, string>;
};

function parentKey(parentSessionKey: string, agentId?: string | null): string {
  return `${agentId?.trim() ?? ""}\0${parentSessionKey.trim()}`;
}

function emptyEntry(): ParentEntry {
  return {
    conversations: [],
    cleanupPendingCount: 0,
    loading: false,
    error: null,
    token: null,
    connectionKey: null,
    pending: new Set(),
    notices: new Map(),
  };
}

/**
 * Shared view of a Gateway connection's side conversations, keyed by parent.
 *
 * Every pane holding the same client reads and notifies one registry, so a
 * transition started in the parent rail updates the child's status strip (and
 * the reverse) without waiting for a row-count change. The Gateway owns
 * membership and lifecycle; a late response from a prior client or parent never
 * replaces a newer view.
 */
export class ChatSideConversations {
  private readonly entries = new Map<string, ParentEntry>();
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }

  view(
    parentSessionKey: string | null | undefined,
    agentId?: string | null,
  ): SideConversationsView | undefined {
    const trimmed = parentSessionKey?.trim();
    if (!trimmed) {
      return undefined;
    }
    const entry = this.entries.get(parentKey(trimmed, agentId));
    return {
      parentSessionKey: trimmed,
      ...(agentId ? { agentId } : {}),
      loading: entry?.loading === true,
      error: entry?.error ?? null,
      conversations: entry?.conversations ?? [],
      cleanupPendingCount: entry?.cleanupPendingCount ?? 0,
      pendingSessionKeys: entry?.pending ?? new Set(),
      notices: entry?.notices ?? new Map(),
    };
  }

  private entry(parentSessionKey: string, agentId?: string | null): ParentEntry {
    const key = parentKey(parentSessionKey, agentId);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = emptyEntry();
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** Reloads one parent unless a refresh for the same connection is already in flight. */
  async load(
    parentSessionKey: string,
    client: GatewayBrowserClient,
    agentId?: string | null,
    options?: { force?: boolean; connectionKey?: string },
  ): Promise<void> {
    const trimmed = parentSessionKey.trim();
    if (!trimmed) {
      return;
    }
    const entry = this.entry(trimmed, agentId);
    // The pane's connection generation is authoritative; a reconnect must refetch.
    const connectionKey = options?.connectionKey ?? "default";
    if (entry.loading && entry.connectionKey === connectionKey && options?.force !== true) {
      return;
    }
    const token = Symbol(trimmed);
    entry.token = token;
    entry.connectionKey = connectionKey;
    entry.loading = true;
    this.notify();
    try {
      const result = await requestSideConversationList(client, {
        parentSessionKey: trimmed,
        ...(agentId ? { agentId } : {}),
      });
      if (this.entries.get(parentKey(trimmed, agentId)) !== entry || entry.token !== token) {
        return;
      }
      this.applyListResult(entry, result);
    } catch (error) {
      if (this.entries.get(parentKey(trimmed, agentId)) !== entry || entry.token !== token) {
        return;
      }
      entry.error = formatUiError(error);
    } finally {
      if (entry.token === token) {
        entry.token = null;
        entry.loading = false;
        this.notify();
      }
    }
  }

  private applyListResult(entry: ParentEntry, result: SideConversationsListResult): void {
    const previous = new Set(entry.conversations.map((conversation) => conversation.sessionKey));
    entry.conversations = sortSideConversations(result.sideConversations);
    entry.cleanupPendingCount = result.cleanupPending?.length ?? 0;
    entry.error = null;
    // A conversation that left the registry can no longer carry an outcome.
    for (const sessionKey of entry.notices.keys()) {
      if (!entry.conversations.some((conversation) => conversation.sessionKey === sessionKey)) {
        entry.notices.delete(sessionKey);
      }
    }
    // The first load has no previous membership; keep notices only across refreshes.
    if (previous.size === 0) {
      entry.notices.clear();
    }
  }

  async create(params: {
    parentSessionKey: string;
    client: GatewayBrowserClient;
    agentId?: string | null;
    label?: string;
  }): Promise<SideConversationSummary | undefined> {
    const parentSessionKey = params.parentSessionKey.trim();
    if (!parentSessionKey) {
      return undefined;
    }
    try {
      const result = await requestSideConversationCreate(params.client, {
        parentSessionKey,
        intentId: sideConversationIntentId(),
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.label ? { label: params.label } : {}),
      });
      const entry = this.entries.get(parentKey(parentSessionKey, params.agentId));
      if (entry) {
        entry.conversations = sortSideConversations([
          ...entry.conversations.filter(
            (conversation) => conversation.sessionKey !== result.conversation.sessionKey,
          ),
          result.conversation,
        ]);
        entry.error = null;
        this.notify();
      }
      return result.conversation;
    } catch (error) {
      const entry = this.entries.get(parentKey(parentSessionKey, params.agentId));
      if (entry) {
        entry.error = formatUiError(error);
        this.notify();
      }
      throw error;
    }
  }

  close(params: SideConversationTargetParams): Promise<void> {
    return this.transition(params, requestSideConversationClose, (conversation) => ({
      conversation,
    }));
  }

  reopen(params: SideConversationTargetParams): Promise<void> {
    return this.transition(params, requestSideConversationReopen, (conversation) => ({
      conversation,
    }));
  }

  abandon(params: SideConversationTargetParams): Promise<void> {
    return this.transition(params, requestSideConversationAbandon, (conversation) => ({
      conversation,
    }));
  }

  async merge(params: SideConversationTargetParams): Promise<void> {
    await this.transition(params, requestSideConversationMerge, (conversation, result) => ({
      conversation,
      notice:
        result.alreadyMerged && result.mergeCommit
          ? "already-merged"
          : result.mergeCommit
            ? "merged"
            : "merged-no-commit",
    }));
  }

  private async transition(
    params: SideConversationTargetParams,
    request: (
      client: GatewayBrowserClient,
      request: {
        parentSessionKey: string;
        sessionKey: string;
        agentId?: string;
      },
    ) => Promise<{
      conversation: SideConversationSummary;
      alreadyMerged?: boolean;
      mergeCommit?: string;
    }>,
    outcome: (
      conversation: SideConversationSummary,
      result: { alreadyMerged?: boolean; mergeCommit?: string },
    ) => { conversation: SideConversationSummary; notice?: string },
  ): Promise<void> {
    const parentSessionKey = params.parentSessionKey.trim();
    const sessionKey = params.sessionKey.trim();
    if (!parentSessionKey || !sessionKey) {
      return;
    }
    const entry = this.entry(parentSessionKey, params.agentId);
    if (entry.pending.has(sessionKey)) {
      return;
    }
    entry.pending.add(sessionKey);
    entry.notices.delete(sessionKey);
    this.notify();
    try {
      const result = await request(params.client, {
        parentSessionKey,
        sessionKey,
        ...(params.agentId ? { agentId: params.agentId } : {}),
      });
      const next = outcome(result.conversation, result);
      if (this.entries.get(parentKey(parentSessionKey, params.agentId)) === entry) {
        entry.conversations = sortSideConversations([
          ...entry.conversations.filter(
            (conversation) => conversation.sessionKey !== next.conversation.sessionKey,
          ),
          next.conversation,
        ]);
        entry.error = null;
        if (next.notice) {
          entry.notices.set(sessionKey, next.notice);
        }
      }
    } catch (error) {
      if (this.entries.get(parentKey(parentSessionKey, params.agentId)) === entry) {
        entry.notices.set(sessionKey, formatUiError(error));
      }
      throw error;
    } finally {
      entry.pending.delete(sessionKey);
      this.notify();
    }
  }
}

const registries = new WeakMap<GatewayBrowserClient, ChatSideConversations>();

/** One registry per Gateway connection; a reconnect yields a fresh client. */
export function sideConversationsFor(client: GatewayBrowserClient): ChatSideConversations {
  let registry = registries.get(client);
  if (!registry) {
    registry = new ChatSideConversations();
    registries.set(client, registry);
  }
  return registry;
}

export type SideConversationTargetParams = {
  parentSessionKey: string;
  sessionKey: string;
  client: GatewayBrowserClient;
  agentId?: string | null;
};
