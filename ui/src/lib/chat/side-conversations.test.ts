import { describe, expect, it } from "vitest";
import type { SideConversationSummary } from "../../../../packages/gateway-protocol/src/index.js";
import {
  isSideConversationSessionKey,
  latestClosedSideConversation,
  sideConversationIntentId,
  sortSideConversations,
} from "./side-conversations.ts";

function summary(
  overrides: Partial<SideConversationSummary> & { sessionKey: string },
): SideConversationSummary {
  return {
    parentSessionKey: "agent:main:run",
    intentId: overrides.sessionKey,
    ordinal: 1,
    state: "open",
    createdAt: 10,
    updatedAt: 10,
    isolation: { filesystem: "worktree", externalState: "shared" },
    ...overrides,
  };
}

describe("side conversation identity", () => {
  it.each([
    "agent:main:dashboard:side-0123456789abcdef0123456789abcdef",
    "agent:work:dashboard:side-0123456789abcdef0123456789abcdef",
  ])("accepts a Gateway child key: %s", (key) => {
    expect(isSideConversationSessionKey(key)).toBe(true);
  });

  it.each([
    "agent:main:run",
    "agent:main:dashboard:main",
    "agent:main:dashboard:side-0123",
    "agent:main:dashboard:side-0123456789abcdef0123456789abcdeZ",
    "",
    null,
    undefined,
  ])("rejects a non-child key: %s", (key) => {
    expect(isSideConversationSessionKey(key)).toBe(false);
  });

  it("builds a protocol-safe, unique intent id", () => {
    const first = sideConversationIntentId();
    const second = sideConversationIntentId();
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
    expect(first).not.toBe(second);
  });
});

describe("side conversation ordering", () => {
  it("keeps open rows ahead of transitions and newest first inside a group", () => {
    const sorted = sortSideConversations([
      summary({ sessionKey: "c", ordinal: 3, state: "merged", updatedAt: 30 }),
      summary({ sessionKey: "a", ordinal: 1, state: "open", updatedAt: 10 }),
      summary({ sessionKey: "b", ordinal: 2, state: "closed", updatedAt: 20 }),
      summary({ sessionKey: "d", ordinal: 4, state: "open", updatedAt: 40 }),
    ]);
    expect(sorted.map((conversation) => conversation.sessionKey)).toEqual(["d", "a", "b", "c"]);
  });

  it("picks the most recently closed child for chip cancellation", () => {
    const latest = latestClosedSideConversation([
      summary({ sessionKey: "old", state: "closed", closedAt: 100 }),
      summary({ sessionKey: "newer", state: "closed", closedAt: 300 }),
      summary({ sessionKey: "open", state: "open" }),
      summary({ sessionKey: "merged", state: "merged", closedAt: 900 }),
    ]);
    expect(latest?.sessionKey).toBe("newer");
    expect(latestClosedSideConversation([])).toBeUndefined();
  });
});
