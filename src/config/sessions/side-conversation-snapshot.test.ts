// Behavior tests for the frozen side-conversation snapshot projection.
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import { projectSessionEntryMessage } from "../../../packages/agent-core/src/harness/session/session.js";
import type { SessionTreeEntry } from "../../../packages/agent-core/src/harness/types.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { replaceSessionEntry, replaceTranscriptEvents } from "./session-accessor.js";
import {
  buildForkedChildTranscriptEvents,
  type ParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import { prepareSideConversationForkTranscript } from "./session-accessor.sqlite-parent-session.js";
import { projectSideConversationSnapshot } from "./side-conversation-snapshot.js";

// Persisted snapshot format: these literals are the transcript contract M201 reads.
const SNAPSHOT_BOUNDARY_ENTRY_ID = "side-conversation-snapshot-boundary";
const SNAPSHOT_CUSTOM_TYPE = "openclaw.side-conversation-snapshot";
const SNAPSHOT_PROJECTION_VERSION = 1;

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function messageEntry(
  id: string,
  parentId: string | null,
  message: Record<string, unknown>,
  timestamp = "2026-01-01T00:00:00.000Z",
) {
  return { type: "message", id, parentId, timestamp, message };
}

function userMessage(id: string, parentId: string | null, content: unknown) {
  return messageEntry(id, parentId, { role: "user", content, timestamp: 1_700_000_000_000 });
}

function assistantMessage(
  id: string,
  parentId: string | null,
  content: unknown,
  overrides: Record<string, unknown> = {},
) {
  return messageEntry(id, parentId, {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: 1_700_000_000_000,
    ...overrides,
  });
}

function toolResultMessage(
  id: string,
  parentId: string | null,
  toolCallId: string,
  content: unknown = [{ type: "text", text: "result" }],
) {
  return messageEntry(id, parentId, {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content,
    isError: false,
    timestamp: 1_700_000_000_000,
  });
}

function toolCallBlock(id: string, extra: Record<string, unknown> = {}) {
  return { type: "toolCall", id, name: "read", arguments: { path: "README.md" }, ...extra };
}

function projectAll(events: unknown[]): AgentMessage[] {
  return events
    .map((event) => projectSessionEntryMessage(event as SessionTreeEntry))
    .filter((message): message is AgentMessage => message !== undefined);
}

function project(branchEntries: unknown[], overrides: Record<string, unknown> = {}) {
  return projectSideConversationSnapshot({
    branchEntries,
    sourceSessionKey: "agent:main:main",
    sourceSessionId: "parent-session",
    sourceLeafEntryId: "a1",
    ...overrides,
  });
}

function entryParentId(entry: unknown): string | null {
  const parentId = (entry as { parentId?: unknown }).parentId;
  return typeof parentId === "string" ? parentId : null;
}

function entryId(entry: unknown): string {
  return (entry as { id: string }).id;
}

describe("projectSideConversationSnapshot", () => {
  it("keeps a complete tool round and re-chains the copied rows", () => {
    const projection = project([
      userMessage("u1", null, "explain the repo"),
      assistantMessage("a1", "u1", [{ type: "text", text: "checking" }, toolCallBlock("call-1")], {
        stopReason: "toolUse",
      }),
      toolResultMessage("r1", "a1", "call-1"),
      assistantMessage("a2", "r1", [{ type: "text", text: "done" }]),
    ]);

    expect(projection.events.map(entryId)).toEqual([
      "u1",
      "a1",
      "r1",
      "a2",
      "side-conversation-snapshot-boundary",
    ]);
    expect(projection.events.slice(0, 4).map(entryParentId)).toEqual([null, "u1", "a1", "r1"]);
    expect(entryParentId(projection.events.at(-1))).toBe("a2");
    expect(projection.facts).toMatchObject({
      sourceSessionKey: "agent:main:main",
      sourceSessionId: "parent-session",
      sourceLeafEntryId: "a1",
      projectionVersion: SNAPSHOT_PROJECTION_VERSION,
      retainedMessages: 4,
      droppedIncompleteToolRounds: 0,
      droppedIncompleteAssistantMessages: 0,
      droppedOrphanToolResults: 0,
    });

    const llmMessages = convertToLlm(projectAll(projection.events));
    expect(llmMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "user",
    ]);
  });

  it("drops an incomplete tool round and counts its orphan results", () => {
    const projection = project([
      userMessage("u1", null, "run both reads"),
      assistantMessage("a1", "u1", [toolCallBlock("call-1"), toolCallBlock("call-2")], {
        stopReason: "toolUse",
      }),
      toolResultMessage("r1", "a1", "call-1"),
      assistantMessage("a2", "r1", [{ type: "text", text: "settled" }]),
    ]);

    expect(projection.events.map(entryId)).toEqual(["u1", "a2", SNAPSHOT_BOUNDARY_ENTRY_ID]);
    expect(projection.facts).toMatchObject({
      retainedMessages: 2,
      droppedIncompleteToolRounds: 1,
      droppedOrphanToolResults: 1,
    });
    expect(entryParentId(projection.events[1])).toBe("u1");
  });

  it("drops aborted and error assistant turns plus their tool results", () => {
    const projection = project([
      userMessage("u1", null, "start"),
      assistantMessage("a1", "u1", [{ type: "text", text: "partial answer" }], {
        stopReason: "aborted",
      }),
      assistantMessage("a2", "a1", [toolCallBlock("call-1")], { stopReason: "error" }),
      toolResultMessage("r1", "a2", "call-1"),
      userMessage("u2", "r1", "try again"),
      assistantMessage("a3", "u2", [{ type: "text", text: "final" }]),
    ]);

    expect(projection.events.map(entryId)).toEqual(["u1", "u2", "a3", SNAPSHOT_BOUNDARY_ENTRY_ID]);
    expect(projection.facts).toMatchObject({
      retainedMessages: 3,
      droppedIncompleteAssistantMessages: 2,
      droppedOrphanToolResults: 1,
    });
  });

  it("turns reasoning into plain text without provider signatures", () => {
    const projection = project([
      userMessage("u1", null, "plan"),
      assistantMessage(
        "a1",
        "u1",
        [
          {
            type: "thinking",
            thinking: "weigh options",
            thinkingSignature: "sig-1",
            redacted: true,
          },
          { type: "text", text: "answer", textSignature: "text-sig" },
          toolCallBlock("call-1", { thoughtSignature: "thought-sig" }),
        ],
        {
          stopReason: "toolUse",
          responseId: "resp-1",
          providerReplay: { v: 1, type: "reasoning", data: "opaque", provider: "anthropic" },
        },
      ),
      toolResultMessage("r1", "a1", "call-1"),
    ]);

    const [assistant] = projection.events.slice(1, 2) as Array<{
      message: { content: Array<Record<string, unknown>> };
    }>;
    const content = assistant?.message.content ?? [];
    expect(content[0]).toEqual({
      type: "text",
      text: "Earlier reasoning snapshot (reference only):\nweigh options",
    });
    expect(content[1]).toEqual({ type: "text", text: "answer" });
    expect(content[2]).toMatchObject({ type: "toolCall", id: "call-1" });
    expect(content[2]).not.toHaveProperty("thoughtSignature");

    const serialized = JSON.stringify(projection.events);
    for (const forbidden of [
      "sig-1",
      "text-sig",
      "thought-sig",
      "resp-1",
      "providerReplay",
      "redacted",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("keeps multimodal user and tool result content intact", () => {
    const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
    const projection = project([
      userMessage("u1", null, [{ type: "text", text: "look", textSignature: "drop-me" }, image]),
      assistantMessage("a1", "u1", [toolCallBlock("call-1")], { stopReason: "toolUse" }),
      toolResultMessage("r1", "a1", "call-1", [
        { type: "text", text: "screenshot" },
        { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" },
      ]),
    ]);

    const [user, , result] = projection.events as Array<{
      message: { content: Array<Record<string, unknown>> };
    }>;
    expect(user?.message.content).toEqual([{ type: "text", text: "look" }, image]);
    expect(result?.message.content).toEqual([
      { type: "text", text: "screenshot" },
      { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" },
    ]);
  });

  it("hides copied rows from display while keeping them in model context", () => {
    const projection = project([
      userMessage("u1", null, "kept"),
      messageEntry(
        "hidden",
        "u1",
        { role: "user", content: "display only", excludeFromContext: true },
        "2026-01-01T00:00:01.000Z",
      ),
      userMessage("u2", "hidden", "visible again"),
    ]);

    for (const entry of projection.events) {
      const record = entry as {
        type?: unknown;
        display?: unknown;
        excludeFromContext?: unknown;
        message?: Record<string, unknown>;
      };
      if (record.type !== "custom_message") {
        expect(record.message?.display).toBe(false);
        expect(record.message).not.toHaveProperty("excludeFromContext");
      }
      expect(record.excludeFromContext).toBeUndefined();
    }
    expect(projection.facts).toMatchObject({
      retainedMessages: 2,
      droppedContextExcludedMessages: 1,
    });
    expect(convertToLlm(projectAll(projection.events))).toHaveLength(3);
  });

  it("counts control rows instead of copying them", () => {
    const projection = project([
      {
        type: "model_change",
        id: "m1",
        parentId: null,
        provider: "anthropic",
        modelId: "x",
        timestamp: "t",
      },
      userMessage("u1", "m1", "hello"),
      {
        type: "compaction",
        id: "c1",
        parentId: "u1",
        summary: "old",
        firstKeptEntryId: "u1",
        tokensBefore: 1,
        timestamp: "t",
      },
      { type: "label", id: "l1", parentId: "c1", targetId: "u1", label: "note", timestamp: "t" },
    ]);

    expect(projection.events.map(entryId)).toEqual(["u1", SNAPSHOT_BOUNDARY_ENTRY_ID]);
    expect(projection.facts.droppedNonMessageEntries).toBe(3);
    expect(projection.facts.retainedMessages).toBe(1);
  });

  it("reproduces identical bytes for the same source", () => {
    const branch = [
      userMessage("u1", null, "hello"),
      assistantMessage("a1", "u1", [
        { type: "thinking", thinking: "reason", thinkingSignature: "s" },
        { type: "text", text: "hi" },
      ]),
      assistantMessage("a2", "a1", [toolCallBlock("call-1")], { stopReason: "toolUse" }),
    ];
    const first = project(branch);
    const second = project(structuredClone(branch));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("appends a hidden boundary naming the source and every drop count", () => {
    const projection = project(
      [
        {
          type: "model_change",
          id: "m1",
          parentId: null,
          provider: "anthropic",
          modelId: "x",
          timestamp: "t",
        },
        messageEntry("x1", "m1", { role: "user", content: "hidden", excludeFromContext: true }),
        messageEntry("c1", "x1", {
          role: "custom",
          customType: "test.note",
          content: "note",
          timestamp: 1_700_000_000_000,
        }),
        userMessage("u1", "c1", "kept"),
        assistantMessage("a1", "u1", [toolCallBlock("call-1")], { stopReason: "toolUse" }),
        toolResultMessage("r1", "a1", "call-2"),
        assistantMessage("a2", "r1", [{ type: "text", text: "partial" }], {
          stopReason: "aborted",
        }),
      ],
      { sourceLeafEntryId: null },
    );

    const boundary = projection.events.at(-1) as Record<string, unknown>;
    expect(boundary).toMatchObject({
      type: "custom_message",
      id: SNAPSHOT_BOUNDARY_ENTRY_ID,
      parentId: "u1",
      customType: SNAPSHOT_CUSTOM_TYPE,
      display: false,
      details: {
        source: "openclaw-side-conversation-snapshot",
        snapshot: projection.facts,
      },
    });
    expect(boundary).not.toHaveProperty("excludeFromContext");
    expect(projection.facts).toMatchObject({
      retainedMessages: 1,
      droppedIncompleteToolRounds: 1,
      droppedIncompleteAssistantMessages: 1,
      droppedOrphanToolResults: 1,
      droppedContextExcludedMessages: 1,
      droppedNonMessageEntries: 1,
      droppedCustomMessages: 1,
    });

    const content = String(boundary.content);
    for (const text of [
      "agent:main:main",
      "parent-session",
      "leaf none",
      "Do not continue, resume, or take over the parent session's task",
      "Only change the worktree or workspace when the operator explicitly asks",
      "1 incomplete tool rounds",
      "1 incomplete assistant messages",
      "1 orphan tool results",
      "1 context-excluded messages",
      "1 non-message entries",
      "1 custom messages",
    ]) {
      expect(content).toContain(text);
    }
    // The boundary is model-only context: it converts to a visible-to-model user turn.
    const boundaryMessage = projectSessionEntryMessage(boundary as unknown as SessionTreeEntry);
    if (!boundaryMessage) {
      throw new Error("expected the boundary row to project into model context");
    }
    expect(convertToLlm([boundaryMessage])).toMatchObject([{ role: "user" }]);
  });
});

describe("side conversation fork integration", () => {
  const source: ParentForkSourceTranscript = {
    appendParentId: "a1",
    branchEntries: [],
    cwd: "/tmp/workspace",
    version: 3,
    labelsToWrite: [
      { targetId: "dropped-control", label: "old label", timestamp: "2026-01-01T00:00:00.000Z" },
    ],
    leafId: "a1",
    preserveLeafControl: true,
  };

  it("replaces the raw branch copy and suppresses labels and leaf controls", () => {
    const branchEntries = [
      {
        type: "model_change",
        id: "dropped-control",
        parentId: null,
        provider: "anthropic",
        modelId: "x",
        timestamp: "t",
      },
      userMessage("u1", "dropped-control", "hello"),
      assistantMessage("a1", "u1", [{ type: "text", text: "hi" }]),
    ];
    const projection = project(branchEntries);
    const build = () =>
      buildForkedChildTranscriptEvents({
        parentSessionFile: "agent:main:main",
        source: { ...source, branchEntries },
        targetSessionId: "child-session",
        sideConversationSnapshot: projection,
      });

    const events = build();
    const header = events[0] as Record<string, unknown>;
    expect(header).toMatchObject({ type: "session", parentSession: "agent:main:main" });
    const copied = events.slice(1);
    expect(copied.map(entryId)).toEqual(["u1", "a1", SNAPSHOT_BOUNDARY_ENTRY_ID]);
    for (const entry of copied) {
      const type = (entry as { type: string }).type;
      expect(type).not.toBe("label");
      expect(type).not.toBe("leaf");
    }
    expect(JSON.stringify(build().slice(1))).toBe(JSON.stringify(copied));
  });

  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-side-conversation-");

  it("prepares a frozen transcript and refuses an oversized snapshot", async () => {
    const root = sessionDirs.make();
    const storePath = path.join(root, "sessions.json");
    const parentKey = "agent:main:side-parent";
    const parentSessionId = "side-parent-session";
    await replaceTranscriptEvents(
      { agentId: "main", sessionId: parentSessionId, sessionKey: parentKey, storePath },
      [
        { type: "session", version: 3, id: parentSessionId, timestamp: "2026-09-15T00:00:00Z" },
        userMessage("u1", null, "explain the change"),
        assistantMessage("a1", "u1", [toolCallBlock("call-1")], { stopReason: "toolUse" }),
        toolResultMessage("r1", "a1", "call-1"),
        assistantMessage("a2", "r1", [{ type: "text", text: "settled answer" }]),
      ],
    );
    await replaceSessionEntry(
      { sessionKey: parentKey, storePath },
      { sessionId: parentSessionId, updatedAt: 1 },
    );

    const prepared = await prepareSideConversationForkTranscript({
      agentId: "main",
      parentEntry: { sessionId: parentSessionId, updatedAt: 1 },
      parentSessionKey: parentKey,
      sessionKey: "agent:main:side-child",
      storePath,
    });

    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") {
      return;
    }
    expect(prepared.snapshot).toMatchObject({
      sourceSessionKey: parentKey,
      sourceSessionId: parentSessionId,
      retainedMessages: 4,
      droppedIncompleteToolRounds: 0,
    });
    const events = prepared.events;
    expect(events).toHaveLength(6);
    expect(entryId(events.at(-1))).toBe(SNAPSHOT_BOUNDARY_ENTRY_ID);

    const oversized = await prepareSideConversationForkTranscript({
      agentId: "main",
      parentEntry: { sessionId: parentSessionId, updatedAt: 1 },
      parentSessionKey: parentKey,
      sessionKey: "agent:main:side-child",
      storePath,
      maxTokens: 1,
    });
    expect(oversized.status).toBe("snapshot-too-large");
    if (oversized.status === "snapshot-too-large") {
      expect(oversized.maxTokens).toBe(1);
      expect(oversized.snapshotTokens).toBeGreaterThan(1);
      expect(oversized.message).toContain("never truncated silently");
      expect(oversized).not.toHaveProperty("events");
    }
  });
});
