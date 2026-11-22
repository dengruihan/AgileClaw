import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionsDeleteResultSchema } from "./sessions-delete.js";
import { SessionsListParamsSchema } from "./sessions-list.js";
import {
  SideConversationsCloseParamsSchema,
  SideConversationsCreateParamsSchema,
  SideConversationsCreateResultSchema,
  SideConversationsListParamsSchema,
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

  it("lists hidden side rows only on request", () => {
    expect(Value.Check(SessionsListParamsSchema, {})).toBe(true);
    expect(Value.Check(SessionsListParamsSchema, { includeSideConversations: true })).toBe(true);
    expect(Value.Check(SessionsListParamsSchema, { includeSideConversations: "yes" })).toBe(false);
  });
});
