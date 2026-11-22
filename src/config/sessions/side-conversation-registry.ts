/**
 * Side-conversation registry owner.
 *
 * The parent session entry holds a private membership registry in its JSON; no
 * schema migration is involved. Intent allocation runs inside the parent row's
 * writer transaction, so concurrent creates cannot share an ordinal, and a
 * retried intent after a restart returns the same child key and ordinal.
 *
 * The hidden child row owns its lifecycle state (`sideConversation.state`).
 * The registry's state copy is a creation/transition record only; readers prefer
 * the child marker whenever the child row still exists.
 */
import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SIDE_CONVERSATION_MAX_PER_PARENT } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadSessionEntry, updateResolvedSessionEntry } from "./session-accessor.entry.js";
import type { SideConversationSnapshotFacts } from "./side-conversation-snapshot.js";
import type {
  SideConversationMarker,
  SideConversationParentRegistry,
  SideConversationRegistryEntry,
  SideConversationState,
} from "./side-conversation-types.js";
import type { InternalSessionEntry } from "./types.js";

/** Re-export the single protocol-owned bound so config and wire cannot drift. */
export { SIDE_CONVERSATION_MAX_PER_PARENT };

const SIDE_CONVERSATION_KEY_PREFIX = "side-";

const SIDE_CONVERSATION_STATES = new Set<SideConversationState>([
  "open",
  "closed",
  "merged",
  "abandoned",
]);

function isRegistryEntry(value: unknown): value is SideConversationRegistryEntry {
  return (
    isRecord(value) &&
    typeof value.sessionKey === "string" &&
    value.sessionKey.length > 0 &&
    typeof value.ordinal === "number" &&
    Number.isInteger(value.ordinal) &&
    value.ordinal >= 1 &&
    typeof value.state === "string" &&
    SIDE_CONVERSATION_STATES.has(value.state as SideConversationState) &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

/** Own-property lookup: prototype names are never registrations. */
function ownConversation(
  registry: SideConversationParentRegistry,
  intentId: string,
): SideConversationRegistryEntry | undefined {
  return Object.hasOwn(registry.conversations, intentId)
    ? registry.conversations[intentId]
    : undefined;
}

function setConversation(
  registry: SideConversationParentRegistry,
  intentId: string,
  entry: SideConversationRegistryEntry,
): SideConversationParentRegistry {
  const conversations = { ...registry.conversations };
  Object.defineProperty(conversations, intentId, {
    value: entry,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return { ...registry, conversations };
}

function deleteConversation(
  registry: SideConversationParentRegistry,
  intentId: string,
): SideConversationParentRegistry {
  if (!Object.hasOwn(registry.conversations, intentId)) {
    return registry;
  }
  const conversations = { ...registry.conversations };
  delete conversations[intentId];
  return { ...registry, conversations };
}

/** Structural check for public-typed entries that still carry the internal marker. */
export function isSideConversationEntry(entry: unknown): boolean {
  return isRecord(entry) && entry.sideConversation !== undefined;
}

type RegistryOwnerEntry = Pick<InternalSessionEntry, "sideConversations">;

export function emptySideConversationRegistry(): SideConversationParentRegistry {
  return { version: 1, nextOrdinal: 1, conversations: {} };
}

/** Read one hidden child row from its parent's physical store. */
export function readSideConversationChildEntry(params: {
  agentId: string;
  sessionKey: string;
  storePath: string;
}): InternalSessionEntry | undefined {
  return loadSessionEntry({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
}

/** Read the registry defensively: legacy or partially written shapes fall back to empty. */
export function readSideConversationRegistry(
  entry: RegistryOwnerEntry | undefined,
): SideConversationParentRegistry {
  const stored = entry?.sideConversations;
  if (
    !stored ||
    stored.version !== 1 ||
    !Number.isInteger(stored.nextOrdinal) ||
    stored.nextOrdinal < 1 ||
    typeof stored.conversations !== "object" ||
    stored.conversations === null
  ) {
    return emptySideConversationRegistry();
  }
  // Object.entries reads own enumerable properties only, so prototype pollution
  // in a stored registry can never become a conversation.
  const conversations: Record<string, SideConversationRegistryEntry> = {};
  for (const [intentId, value] of Object.entries(stored.conversations)) {
    if (isRegistryEntry(value)) {
      conversations[intentId] = value;
    }
  }
  return { version: 1, nextOrdinal: stored.nextOrdinal, conversations };
}

/** Count registered conversations; abandoned intents stop counting as side conversations. */
export function resolveSideConversationCount(entry: RegistryOwnerEntry | undefined): number {
  const registry = entry?.sideConversations;
  if (!registry) {
    return 0;
  }
  let count = 0;
  for (const conversation of Object.values(registry.conversations)) {
    if (conversation.state !== "abandoned") {
      count += 1;
    }
  }
  return count;
}

export function findSideConversationByIntent(
  entry: RegistryOwnerEntry | undefined,
  intentId: string,
): SideConversationRegistryEntry | undefined {
  const registry = entry?.sideConversations;
  return registry ? ownConversation(registry, intentId) : undefined;
}

/**
 * Deterministic dashboard key for one (parent, intent) pair.
 *
 * Determinism is what makes creation idempotent across restarts: a retried
 * intent finds the already committed child row even if the parent registry
 * write never landed.
 */
export function buildSideConversationSessionKey(params: {
  agentId: string;
  parentSessionKey: string;
  intentId: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([params.parentSessionKey.trim(), params.intentId]))
    .digest("hex")
    .slice(0, 32);
  return `agent:${params.agentId}:dashboard:${SIDE_CONVERSATION_KEY_PREFIX}${digest}`;
}

export function buildSideConversationMarker(params: {
  parentSessionKey: string;
  parentSessionId?: string;
  intentId: string;
  ordinal: number;
  now: number;
}): SideConversationMarker {
  return {
    parentSessionKey: params.parentSessionKey,
    ...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
    intentId: params.intentId,
    ordinal: params.ordinal,
    state: "open",
    createdAt: params.now,
    updatedAt: params.now,
  };
}

export type SideConversationReservation =
  | {
      status: "reserved";
      ordinal: number;
      /** Present when the intent was already registered; the child key must match it. */
      existing?: SideConversationRegistryEntry;
    }
  | { status: "limit-reached" }
  | { status: "missing-parent" };

/**
 * Reserve (or find) one intent inside the parent row writer transaction.
 *
 * A registered intent is returned untouched, including its ordinal. A new intent
 * takes the next monotonic ordinal and records its deterministic child key
 * before the child exists, so a crash leaves a recoverable reservation instead
 * of a duplicate child.
 */
export async function reserveSideConversationIntent(params: {
  agentId: string;
  cfg: OpenClawConfig;
  intentId: string;
  now: number;
  parentSessionId?: string;
  parentSessionKey: string;
  sessionKey: string;
}): Promise<SideConversationReservation> {
  let outcome: SideConversationReservation = { status: "missing-parent" };
  const updated = await updateResolvedSessionEntry(
    { agentId: params.agentId, cfg: params.cfg, sessionKey: params.parentSessionKey },
    (entry) => {
      const registry = readSideConversationRegistry(entry);
      const existing = ownConversation(registry, params.intentId);
      if (existing) {
        outcome = { status: "reserved", ordinal: existing.ordinal, existing };
        return;
      }
      const activeCount = Object.values(registry.conversations).filter(
        (conversation) => conversation.state !== "abandoned",
      ).length;
      if (activeCount >= SIDE_CONVERSATION_MAX_PER_PARENT) {
        outcome = { status: "limit-reached" };
        return;
      }
      const ordinal = registry.nextOrdinal;
      entry.sideConversations = setConversation(
        { ...registry, nextOrdinal: ordinal + 1 },
        params.intentId,
        {
          sessionKey: params.sessionKey,
          ordinal,
          state: "open",
          createdAt: params.now,
          updatedAt: params.now,
        },
      );
      outcome = { status: "reserved", ordinal };
    },
  );
  return updated.found ? outcome : { status: "missing-parent" };
}

/** Record the committed child identity and frozen snapshot facts after creation. */
export async function finalizeSideConversationIntent(params: {
  agentId: string;
  cfg: OpenClawConfig;
  intentId: string;
  now: number;
  parentSessionKey: string;
  sessionId?: string;
  snapshot?: SideConversationSnapshotFacts;
}): Promise<boolean> {
  const updated = await updateResolvedSessionEntry(
    { agentId: params.agentId, cfg: params.cfg, sessionKey: params.parentSessionKey },
    (entry) => {
      const registry = readSideConversationRegistry(entry);
      const existing = ownConversation(registry, params.intentId);
      if (!existing) {
        // Only a reserved intent is finalized; a caller that already re-reserved
        // in the replay path will hit that reservation.
        return;
      }
      entry.sideConversations = setConversation(registry, params.intentId, {
        ...existing,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.snapshot ? { snapshot: params.snapshot } : {}),
        updatedAt: params.now,
      });
    },
  );
  return updated.found;
}

/** Mirror a child lifecycle transition into the parent registry (best-effort cache). */
export async function recordSideConversationState(params: {
  agentId: string;
  cfg: OpenClawConfig;
  intentId: string;
  now: number;
  parentSessionKey: string;
  state: SideConversationState;
}): Promise<boolean> {
  const updated = await updateResolvedSessionEntry(
    { agentId: params.agentId, cfg: params.cfg, sessionKey: params.parentSessionKey },
    (entry) => {
      const registry = readSideConversationRegistry(entry);
      const existing = ownConversation(registry, params.intentId);
      if (!existing) {
        return;
      }
      entry.sideConversations = setConversation(registry, params.intentId, {
        ...existing,
        state: params.state,
        updatedAt: params.now,
        ...(params.state === "closed" ? { closedAt: params.now } : {}),
      });
    },
  );
  return updated.found;
}

/** Drop one child from the registry (used when a hidden child is deleted directly). */
export async function removeSideConversationIntent(params: {
  agentId: string;
  cfg: OpenClawConfig;
  intentId: string;
  parentSessionKey: string;
}): Promise<boolean> {
  const updated = await updateResolvedSessionEntry(
    { agentId: params.agentId, cfg: params.cfg, sessionKey: params.parentSessionKey },
    (entry) => {
      const registry = readSideConversationRegistry(entry);
      entry.sideConversations = deleteConversation(registry, params.intentId);
    },
  );
  return updated.found;
}

/** Reserved child keys that belong to a parent, in ordinal order. */
export function listSideConversationRegistrations(
  entry: RegistryOwnerEntry | undefined,
): Array<[string, SideConversationRegistryEntry]> {
  const registry = readSideConversationRegistry(entry);
  return Object.entries(registry.conversations).toSorted(
    (left, right) => left[1].ordinal - right[1].ordinal,
  );
}
