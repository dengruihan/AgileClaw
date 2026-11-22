/**
 * Stored shapes for persistent side conversations.
 *
 * The parent session entry owns the membership registry (private projection);
 * each hidden child owns its own marker (public projection) and transcript.
 * State lives on the child marker because the child row is the durable owner of
 * its lifecycle; the registry keeps creation-time facts and the ordinal.
 */
import type { SideConversationSnapshotFacts } from "./side-conversation-snapshot.js";

export type SideConversationState = "open" | "closed" | "merged" | "abandoned";

/** Registry-only membership state: the child row is being (or was) deleted. */
export type SideConversationRegistryState = SideConversationState | "deleting";

/** Public marker persisted on the hidden child row. */
export type SideConversationMarker = {
  parentSessionKey: string;
  parentSessionId?: string;
  intentId: string;
  ordinal: number;
  state: SideConversationState;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
};

/** One parent registry record; keyed by intentId in the parent entry. */
export type SideConversationRegistryEntry = {
  /** Deterministic dashboard key of the hidden child. */
  sessionKey: string;
  sessionId?: string;
  ordinal: number;
  /** Last state written by the creation or transition owner; the child marker wins on read. */
  state: SideConversationRegistryState;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  snapshot?: SideConversationSnapshotFacts;
};

/** Private parent registry stored in the parent's SessionEntry JSON. */
/** Durable cleanup work left after a child row was deleted. */
export type SideConversationCleanupPending = {
  intentId: string;
  sessionKey: string;
};

export type SideConversationParentRegistry = {
  version: 1;
  /** Next ordinal to hand out; monotonic across restarts. */
  nextOrdinal: number;
  /** intentId -> membership record. */
  conversations: Record<string, SideConversationRegistryEntry>;
};
