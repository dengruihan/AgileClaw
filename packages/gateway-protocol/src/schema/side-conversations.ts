import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Side conversations are persistent, hidden children of one dashboard session.
 * The parent owns the membership registry; each child owns its own transcript,
 * worktree, and lifecycle state. These schemas are the wire contract only; the
 * stored shapes live with the session config owner.
 */

/** Hard bound on one parent's registry so the parent entry JSON stays small. */
export const SIDE_CONVERSATION_MAX_PER_PARENT = 32;

/** Hard bound on one list response; a parent never exceeds the registry cap. */
export const SIDE_CONVERSATION_MAX_LISTED = SIDE_CONVERSATION_MAX_PER_PARENT;

export const SIDE_CONVERSATION_MAX_INTENT_ID_LENGTH = 128;

/**
 * Caller-owned idempotency keys are opaque identifiers. Leading alphanumerics
 * plus `_`/`-` keep them safe as own registry properties and reject prototype
 * names such as `__proto__`, `constructor`, or `toString`.
 */
export const SIDE_CONVERSATION_INTENT_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]*$";

/** Lifecycle state values; merged and abandoned are reserved for later handoff work. */
export const SideConversationStateSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("closed"),
  Type.Literal("merged"),
  Type.Literal("abandoned"),
]);

/** Frozen snapshot facts recorded by the M200 projection at creation time. */
export const SideConversationSnapshotFactsSchema = closedObject({
  sourceSessionKey: NonEmptyString,
  sourceSessionId: NonEmptyString,
  sourceLeafEntryId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  projectionVersion: Type.Integer({ minimum: 1 }),
  retainedMessages: Type.Integer({ minimum: 0 }),
  droppedIncompleteToolRounds: Type.Integer({ minimum: 0 }),
  droppedIncompleteAssistantMessages: Type.Integer({ minimum: 0 }),
  droppedOrphanToolResults: Type.Integer({ minimum: 0 }),
  droppedContextExcludedMessages: Type.Integer({ minimum: 0 }),
  droppedNonMessageEntries: Type.Integer({ minimum: 0 }),
  droppedCustomMessages: Type.Integer({ minimum: 0 }),
});

/** Persisted marker on the hidden child row; safe for the child's own describe. */
export const SideConversationRowMarkerSchema = closedObject({
  parentSessionKey: NonEmptyString,
  parentSessionId: Type.Optional(NonEmptyString),
  intentId: NonEmptyString,
  ordinal: Type.Integer({ minimum: 1 }),
  state: SideConversationStateSchema,
  createdAt: Type.Number({ minimum: 0 }),
  updatedAt: Type.Number({ minimum: 0 }),
  closedAt: Type.Optional(Type.Number({ minimum: 0 })),
});

/** Registry membership whose row is gone but whose cleanup is still pending. */
export const SideConversationCleanupPendingSchema = closedObject({
  intentId: NonEmptyString,
  sessionKey: NonEmptyString,
});

/** One side-conversation child left unprocessed by a partial parent action. */
export const SideConversationRemainderSchema = closedObject({
  key: NonEmptyString,
  code: NonEmptyString,
  message: Type.String(),
});

/** Why a side conversation could not get its own checkout. Never claims isolation. */
export const SideConversationWorktreeSkipReasonSchema = Type.Union([
  /** The parent's workspace is not inside a Git checkout. */
  Type.Literal("not-git"),
  /** The parent runs on a remote node, so a local checkout is not its workspace. */
  Type.Literal("remote-exec"),
  /** The child has no resolvable Git source, for example a row created before this feature. */
  Type.Literal("unavailable"),
]);

/** One materialized managed worktree bound to the hidden child. */
export const SideConversationWorktreeFactsSchema = closedObject({
  id: NonEmptyString,
  branch: NonEmptyString,
  path: NonEmptyString,
  /**
   * Parent's committed HEAD recorded at creation. Side conversations pin the
   * exact commit here, so uncommitted parent edits are never copied.
   */
  baseRef: Type.Optional(NonEmptyString),
});

/**
 * Filesystem and external-state isolation are separate facts. A side conversation
 * never isolates databases, listening ports, or network APIs from the parent.
 */
export const SideConversationIsolationSchema = closedObject({
  filesystem: Type.Union([Type.Literal("worktree"), Type.Literal("shared")]),
  externalState: Type.Literal("shared"),
});

/** One registered side conversation as returned by the new RPCs. */
export const SideConversationSummarySchema = closedObject({
  sessionKey: NonEmptyString,
  sessionId: Type.Optional(NonEmptyString),
  parentSessionKey: NonEmptyString,
  parentSessionId: Type.Optional(NonEmptyString),
  intentId: NonEmptyString,
  ordinal: Type.Integer({ minimum: 1 }),
  state: SideConversationStateSchema,
  createdAt: Type.Number({ minimum: 0 }),
  updatedAt: Type.Number({ minimum: 0 }),
  closedAt: Type.Optional(Type.Number({ minimum: 0 })),
  title: Type.Optional(Type.String()),
  modelProvider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  snapshot: Type.Optional(SideConversationSnapshotFactsSchema),
  isolation: SideConversationIsolationSchema,
  /** Present when the child owns its own checkout. */
  worktree: Type.Optional(SideConversationWorktreeFactsSchema),
  /** Present when the child shares the parent checkout instead of being isolated. */
  worktreeSkipped: Type.Optional(SideConversationWorktreeSkipReasonSchema),
});

const ParentTargetParams = {
  parentSessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
};

export const SideConversationsCreateParamsSchema = closedObject({
  ...ParentTargetParams,
  /** Caller-owned idempotency key; retries return the same hidden child. */
  intentId: Type.String({
    minLength: 1,
    maxLength: SIDE_CONVERSATION_MAX_INTENT_ID_LENGTH,
    pattern: SIDE_CONVERSATION_INTENT_ID_PATTERN,
  }),
  /** Optional child title; omitted derives from the first message. */
  label: Type.Optional(Type.String()),
});

export const SideConversationsCreateResultSchema = closedObject({
  ok: Type.Literal(true),
  /** False when an existing intent was reused instead of creating a new child. */
  created: Type.Boolean(),
  conversation: SideConversationSummarySchema,
});

export const SideConversationsListParamsSchema = closedObject({
  ...ParentTargetParams,
  state: Type.Optional(SideConversationStateSchema),
});

export const SideConversationsListResultSchema = closedObject({
  ok: Type.Literal(true),
  parentSessionKey: NonEmptyString,
  sideConversations: Type.Array(SideConversationSummarySchema, {
    maxItems: SIDE_CONVERSATION_MAX_LISTED,
  }),
  /** Retryable membership cleanup left after a child row was deleted. */
  cleanupPending: Type.Optional(
    Type.Array(SideConversationCleanupPendingSchema, { maxItems: SIDE_CONVERSATION_MAX_LISTED }),
  ),
});

export const SideConversationsCloseParamsSchema = closedObject({
  ...ParentTargetParams,
  /** Exact hidden child key registered under the parent. */
  sessionKey: NonEmptyString,
});

export const SideConversationsReopenParamsSchema = SideConversationsCloseParamsSchema;

/** Manual merge of the child's committed branch into the parent checkout. */
export const SideConversationsMergeParamsSchema = SideConversationsCloseParamsSchema;

/** Keep the branch and checkout, and only record that the conversation was dropped. */
export const SideConversationsAbandonParamsSchema = SideConversationsCloseParamsSchema;

/** Explicit delete is the only operation that may retire the child's checkout. */
export const SideConversationsDeleteParamsSchema = closedObject({
  ...ParentTargetParams,
  sessionKey: NonEmptyString,
  deleteTranscript: Type.Optional(Type.Boolean()),
});

export const SideConversationsTransitionResultSchema = closedObject({
  ok: Type.Literal(true),
  conversation: SideConversationSummarySchema,
});

export const SideConversationsMergeResultSchema = closedObject({
  ok: Type.Literal(true),
  conversation: SideConversationSummarySchema,
  /**
   * Commit that contains the merged branch: the merge commit created by this
   * call, or the original landing commit when the branch was already merged.
   */
  mergeCommit: Type.Optional(NonEmptyString),
  alreadyMerged: Type.Boolean(),
});

/**
 * Bounded server-owned worktree preservation reasons.
 *
 * Mirrors `WORKTREE_PRESERVATION_REASONS` in the session-delete owner; this
 * module cannot import that one at runtime because it already imports this
 * module. A schema test pins the two lists to the same vocabulary.
 */
export const SIDE_CONVERSATION_WORKTREE_PRESERVATION_REASONS = [
  "owner-mismatch",
  "busy",
  "foreign-lock",
  "snapshot-failed",
  "cleanup-failed",
] as const;

export const SideConversationWorktreePreservationReasonSchema = Type.Enum(
  SIDE_CONVERSATION_WORKTREE_PRESERVATION_REASONS,
  { type: "string" },
);

export const SideConversationsDeleteResultSchema = closedObject({
  ok: Type.Literal(true),
  sessionKey: NonEmptyString,
  deleted: Type.Literal(true),
  /** Retryable cleanup left after the row was already deleted. */
  cleanupPending: Type.Optional(
    Type.Array(SideConversationRemainderSchema, { maxItems: SIDE_CONVERSATION_MAX_LISTED }),
  ),
  /** Present when cleanup refused to retire the checkout; it stays on disk as reported. */
  worktreePreserved: Type.Optional(
    closedObject({
      id: NonEmptyString,
      branch: NonEmptyString,
      path: NonEmptyString,
      reason: SideConversationWorktreePreservationReasonSchema,
    }),
  ),
});

export type SideConversationCleanupPending = Static<typeof SideConversationCleanupPendingSchema>;
export type SideConversationRemainder = Static<typeof SideConversationRemainderSchema>;
export type SideConversationState = Static<typeof SideConversationStateSchema>;
export type SideConversationSnapshotFacts = Static<typeof SideConversationSnapshotFactsSchema>;
export type SideConversationRowMarker = Static<typeof SideConversationRowMarkerSchema>;
export type SideConversationSummary = Static<typeof SideConversationSummarySchema>;
export type SideConversationsCreateParams = Static<typeof SideConversationsCreateParamsSchema>;
export type SideConversationsCreateResult = Static<typeof SideConversationsCreateResultSchema>;
export type SideConversationsListParams = Static<typeof SideConversationsListParamsSchema>;
export type SideConversationsListResult = Static<typeof SideConversationsListResultSchema>;
export type SideConversationsCloseParams = Static<typeof SideConversationsCloseParamsSchema>;
export type SideConversationsReopenParams = Static<typeof SideConversationsReopenParamsSchema>;
export type SideConversationsMergeParams = Static<typeof SideConversationsMergeParamsSchema>;
export type SideConversationsAbandonParams = Static<typeof SideConversationsAbandonParamsSchema>;
export type SideConversationsDeleteParams = Static<typeof SideConversationsDeleteParamsSchema>;
export type SideConversationsTransitionResult = Static<
  typeof SideConversationsTransitionResultSchema
>;
export type SideConversationsMergeResult = Static<typeof SideConversationsMergeResultSchema>;
export type SideConversationsDeleteResult = Static<typeof SideConversationsDeleteResultSchema>;
export type SideConversationWorktreeFact = Static<typeof SideConversationWorktreeFactsSchema>;
export type SideConversationWorktreeSkipReason = Static<
  typeof SideConversationWorktreeSkipReasonSchema
>;
export type SideConversationIsolation = Static<typeof SideConversationIsolationSchema>;
