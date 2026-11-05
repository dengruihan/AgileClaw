import { expect, it } from "vitest";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntry, upsertSessionEntryCore } from "./session-accessor.js";
import { mergeSessionEntry } from "./types.js";

it("persists scopeDeviceId through the canonical entry store and metadata patches", async () => {
  await withOpenClawTestState({ label: "scope-device-roundtrip" }, async () => {
    const agentId = "main";
    const scope = {
      agentId,
      sessionKey: "agent:main:scoped",
      storePath: resolveOpenClawAgentSqlitePath({ agentId }),
    };
    await upsertSessionEntryCore(scope, {
      sessionId: "scoped-1",
      updatedAt: 1,
      scopeDeviceId: "device-a",
    });
    // Hot metadata survives the SQLite round trip without any schema bump.
    expect(loadSessionEntry(scope)).toMatchObject({
      sessionId: "scoped-1",
      scopeDeviceId: "device-a",
    });

    // Compaction-style and recovery-style patches keep the scope.
    await upsertSessionEntryCore(scope, {
      updatedAt: 2,
      memoryFlush: { kind: "succeeded", compactionCount: 1 },
      restartRecoveryForceSafeTools: true,
    });
    expect(loadSessionEntry(scope)?.scopeDeviceId).toBe("device-a");

    // Reset-style generation rotation keeps the same node and its scope.
    await upsertSessionEntryCore(scope, {
      sessionId: "scoped-2",
      updatedAt: 3,
      previousSessionId: "scoped-1",
      totalTokens: undefined,
      totalTokensFresh: false,
    });
    expect(loadSessionEntry(scope)).toMatchObject({
      sessionId: "scoped-2",
      scopeDeviceId: "device-a",
    });
  });
});

it("keeps an absent scope gateway-hosted and never invents one", async () => {
  await withOpenClawTestState({ label: "scope-device-absent" }, async () => {
    const agentId = "main";
    const scope = {
      agentId,
      sessionKey: "agent:main:gateway",
      storePath: resolveOpenClawAgentSqlitePath({ agentId }),
    };
    await upsertSessionEntryCore(scope, { sessionId: "gateway-1", updatedAt: 1 });
    await upsertSessionEntryCore(scope, { updatedAt: 2, modelOverride: "fixture/model" });
    expect(loadSessionEntry(scope)?.scopeDeviceId).toBeUndefined();
  });
});

it("keeps a stored scope through sparse merges and lets a fork patch set or clear it", () => {
  const scoped = { sessionId: "scoped", updatedAt: 1, scopeDeviceId: "device-a" };
  // Bookkeeping, compaction, resume, and reset patches never name the field.
  expect(mergeSessionEntry(scoped, { updatedAt: 2, label: "renamed" }).scopeDeviceId).toBe(
    "device-a",
  );
  // A fork names it explicitly: it adopts the parent's scope, or clears a stale
  // value when the parent is gateway-hosted.
  expect(
    mergeSessionEntry(scoped, { updatedAt: 2, scopeDeviceId: "device-parent" }).scopeDeviceId,
  ).toBe("device-parent");
  expect(
    mergeSessionEntry(scoped, { updatedAt: 2, scopeDeviceId: undefined }).scopeDeviceId,
  ).toBeUndefined();
  // A new node still takes its scope from the creation patch alone.
  expect(mergeSessionEntry(undefined, { ...scoped }).scopeDeviceId).toBe("device-a");
  expect(
    mergeSessionEntry({ sessionId: "plain", updatedAt: 1 }, { updatedAt: 2 }).scopeDeviceId,
  ).toBeUndefined();
});
