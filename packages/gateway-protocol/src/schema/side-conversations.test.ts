import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionsDeleteResultSchema } from "./sessions-delete.js";
import { SessionsListParamsSchema } from "./sessions-list.js";
import {
  SideConversationsListResultSchema,
  SideConversationsCloseParamsSchema,
  SideConversationsCreateParamsSchema,
  SideConversationsCreateResultSchema,
  SideConversationsDeleteParamsSchema,
  SideConversationsDeleteResultSchema,
  SideConversationsListParamsSchema,
  SideConversationsMergeParamsSchema,
  SideConversationsMergeResultSchema,
  SIDE_CONVERSATION_MAX_INTENT_ID_LENGTH,
  SIDE_CONVERSATION_MAX_LISTED,
  SIDE_CONVERSATION_MAX_PER_PARENT,
} from "./side-conversations.js";

const parentSessionKey = "agent:main:dashboard:parent";
const childSessionKey = "agent:main:dashboard:side-abc";

const summary = {
  sessionKey: childSessionKey,
  sessionId: "session-1",
  parentSessionKey,
  parentSessionId: "parent-1",
  intentId: "intent-1",
  ordinal: 1,
  state: "open",
  createdAt: 1,
  updatedAt: 1,
  isolation: { filesystem: "worktree", externalState: "shared" },
  worktree: {
    id: "wt-1",
    branch: "openclaw/side-1",
    path: "/tmp/worktrees/wt-1",
    baseRef: "a".repeat(40),
  },
};

describe("side conversation protocol schemas", () => {
  it("accepts a bounded intent and rejects empty, oversized, or unknown input", () => {
    expect(
      Value.Check(SideConversationsCreateParamsSchema, {
        parentSessionKey,
        intentId: "intent-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(SideConversationsCreateParamsSchema, {
        parentSessionKey,
        intentId: "",
      }),
    ).toBe(false);
    expect(
      Value.Check(SideConversationsCreateParamsSchema, {
        parentSessionKey,
        intentId: "x".repeat(SIDE_CONVERSATION_MAX_INTENT_ID_LENGTH + 1),
      }),
    ).toBe(false);
    expect(
      Value.Check(SideConversationsCreateParamsSchema, {
        parentSessionKey,
        intentId: "intent-1",
        model: "openai/gpt",
      }),
    ).toBe(false);
  });

  it("keeps the create result summary closed and state-bounded", () => {
    expect(
      Value.Check(SideConversationsCreateResultSchema, {
        ok: true,
        created: true,
        conversation: summary,
      }),
    ).toBe(true);
    expect(
      Value.Check(SideConversationsCreateResultSchema, {
        ok: true,
        created: true,
        conversation: { ...summary, state: "deleted" },
      }),
    ).toBe(false);
    expect(
      Value.Check(SideConversationsCreateResultSchema, {
        ok: true,
        created: true,
        conversation: { ...summary, childSessions: [childSessionKey] },
      }),
    ).toBe(false);
  });

  it("rejects prototype-polluting intent ids and keeps one shared bound", () => {
    expect(
      Value.Check(SideConversationsCreateParamsSchema, {
        parentSessionKey,
        intentId: "__proto__",
      }),
    ).toBe(false);
    // Identifier-shaped names are safe as own properties and remain legal keys.
    for (const intentId of ["constructor", "toString", "prototype"]) {
      expect(Value.Check(SideConversationsCreateParamsSchema, { parentSessionKey, intentId })).toBe(
        true,
      );
    }
    expect(SIDE_CONVERSATION_MAX_LISTED).toBe(SIDE_CONVERSATION_MAX_PER_PARENT);
  });

  it("scopes list and transitions by parent or exact child key", () => {
    expect(Value.Check(SideConversationsListParamsSchema, { parentSessionKey })).toBe(true);
    expect(Value.Check(SideConversationsListParamsSchema, {})).toBe(false);
    expect(
      Value.Check(SideConversationsCloseParamsSchema, {
        parentSessionKey,
        sessionKey: childSessionKey,
      }),
    ).toBe(true);
    expect(Value.Check(SideConversationsCloseParamsSchema, { parentSessionKey })).toBe(false);
  });

  it("accepts a partial delete result that keeps the parent", () => {
    expect(
      Value.Check(SessionsDeleteResultSchema, {
        ok: true,
        key: parentSessionKey,
        deleted: false,
        archived: [],
        partial: true,
        deletedKeys: [childSessionKey],
        remainingSideConversations: [
          { key: "agent:main:dashboard:side-later", code: "CHILD_ACTIVE", message: "active" },
        ],
        cleanupPending: [
          { key: childSessionKey, code: "REGISTRY_CLEANUP_PENDING", message: "pending" },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionsDeleteResultSchema, {
        ok: true,
        key: parentSessionKey,
        deleted: false,
        archived: [],
        remainingSideConversations: [{ key: childSessionKey, code: 3, message: "bad" }],
      }),
    ).toBe(false);
  });

  it("exposes retryable cleanup tombstones from the list owner", () => {
    expect(
      Value.Check(SideConversationsListResultSchema, {
        ok: true,
        parentSessionKey,
        sideConversations: [summary],
        cleanupPending: [{ intentId: "intent-1", sessionKey: childSessionKey }],
      }),
    ).toBe(true);
    expect(
      Value.Check(SideConversationsListResultSchema, {
        ok: true,
        parentSessionKey,
        sideConversations: [],
        cleanupPending: [{ intentId: "intent-1" }],
      }),
    ).toBe(false);
  });

  it("reports worktree isolation and skip reasons without claiming external isolation", () => {
    expect(
      Value.Check(SideConversationsCreateResultSchema, {
        ok: true,
        created: true,
        conversation: {
          ...summary,
          isolation: { filesystem: "shared", externalState: "shared" },
          worktree: undefined,
          worktreeSkipped: "not-git",
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(SideConversationsCreateResultSchema, {
        ok: true,
        created: true,
        conversation: { ...summary, worktreeSkipped: "pretend-isolated" },
      }),
    ).toBe(false);
    expect(
      Value.Check(SideConversationsCreateResultSchema, {
        ok: true,
        created: true,
        conversation: {
          ...summary,
          isolation: { filesystem: "worktree", externalState: "isolated" },
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(SideConversationsCreateResultSchema, {
        ok: true,
        created: true,
        conversation: { ...summary, isolation: undefined },
      }),
    ).toBe(false);
  });

  it("bounds merge, abandon, and explicit delete inputs and results", () => {
    for (const params of [
      { parentSessionKey, sessionKey: childSessionKey },
      { parentSessionKey, sessionKey: childSessionKey, agentId: "main" },
    ]) {
      expect(Value.Check(SideConversationsMergeParamsSchema, params)).toBe(true);
      expect(Value.Check(SideConversationsDeleteParamsSchema, params)).toBe(true);
    }
    expect(Value.Check(SideConversationsMergeParamsSchema, { parentSessionKey })).toBe(false);
    expect(
      Value.Check(SideConversationsDeleteParamsSchema, {
        parentSessionKey,
        sessionKey: childSessionKey,
        force: true,
      }),
    ).toBe(false);
    expect(
      Value.Check(SideConversationsMergeResultSchema, {
        ok: true,
        conversation: { ...summary, state: "merged" },
        mergeCommit: "b".repeat(40),
        alreadyMerged: false,
      }),
    ).toBe(true);
    expect(
      Value.Check(SideConversationsMergeResultSchema, {
        ok: true,
        conversation: { ...summary, state: "merged" },
        alreadyMerged: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(SideConversationsDeleteResultSchema, {
        ok: true,
        sessionKey: childSessionKey,
        deleted: true,
        worktreePreserved: { branch: "openclaw/side-1", path: "/tmp/wt-1", reason: "busy" },
        cleanupPending: [{ key: childSessionKey, code: "CHILD_ACTIVE", message: "active" }],
      }),
    ).toBe(true);
  });

  it("lists hidden side rows only on request", () => {
    expect(Value.Check(SessionsListParamsSchema, {})).toBe(true);
    expect(Value.Check(SessionsListParamsSchema, { includeSideConversations: true })).toBe(true);
    expect(Value.Check(SessionsListParamsSchema, { includeSideConversations: "yes" })).toBe(false);
  });
});
