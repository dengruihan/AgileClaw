import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { recordDeviceLeaseDecision } from "./device-lease-decision.js";
import {
  pageExecutionDecisionFactsForContextInDatabase,
  pruneExpiredExecutionDecisionFactsInDatabase,
} from "./execution-decision-facts.js";
import { seedExecutionContext } from "./execution-decision-facts.test-support.js";
import {
  configureExecutionDecisionWorkSink,
  processExecutionDecisionWorkInDatabase,
} from "./execution-decision-work.js";
import { createExecutionIdentityAdmissionToken } from "./execution-identity-admission.js";
import {
  clearToolActionDeviceScopesForTest,
  hashAuditDeviceRef,
  publishToolActionDeviceScope,
  readToolActionDeviceRef,
} from "./tool-action-device-scope.js";

const RETENTION_MS = 30 * 24 * 60 * 60_000;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  clearToolActionDeviceScopesForTest();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databaseOptions() {
  return {
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-device-lease-facts-") },
  };
}

/** Install the real writer pipeline so producer work persists like production. */
function persistingSink(database: ReturnType<typeof databaseOptions>) {
  return configureExecutionDecisionWorkSink((work) => {
    processExecutionDecisionWorkInDatabase(work, {
      ...database,
      database: openOpenClawStateDatabase(database),
      // Pin the retention clock to the fixture timestamps (occurredAt 100).
      now: 100,
    });
    return true;
  });
}

describe("device lease decision facts", () => {
  it("persists an acquire fact with HMAC-projected refs and no raw identity", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    const token = createExecutionIdentityAdmissionToken(context.runId, {
      contextId: context.contextId,
      executionId: context.executionId,
      now: context.createdAt,
    });
    const clear = persistingSink(database);
    try {
      expect(
        recordDeviceLeaseDecision({
          token,
          phase: "acquire",
          deviceId: "device-a",
          rootSessionKey: "agent:main:root",
          agentId: "main",
          permissionMode: "guarded",
          leaseToken: "node-lease-token",
          occurredAt: 100,
        }),
      ).toBe(true);
    } finally {
      clear();
    }
    const opened = openOpenClawStateDatabase(database);
    const page = pageExecutionDecisionFactsForContextInDatabase(opened.db, {
      context: {
        contextId: context.contextId,
        executionId: context.executionId,
        runId: context.runId,
      },
      limit: 10,
      now: 100,
    });
    expect(page.receipts).toHaveLength(1);
    const receipt = page.receipts[0]!;
    expect(receipt.action).toMatchObject({
      family: "device",
      operation: "device.lease.acquire",
      resourceRef: expect.stringMatching(/^hmac-sha256:v1:/),
      targetRef: expect.stringMatching(/^hmac-sha256:v1:/),
    });
    expect(receipt.decision).toEqual({
      outcome: "allowed",
      reasonCode: "device_lease_acquired",
    });
    expect(receipt.enforcement).toMatchObject({
      coverageState: "enforced",
      policyRefs: ["session-permission-mode:guarded"],
    });
    expect(receipt.occurredAt).toBe(100);
    // Raw identity bytes never persist, including the opaque node lease token.
    const retained = JSON.stringify(page.receipts);
    expect(retained).not.toContain("device-a");
    expect(retained).not.toContain("agent:main:root");
    expect(retained).not.toContain("node-lease-token");
  });

  it("keeps one row per transition: a replayed transition deduplicates by receipt id", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    const token = createExecutionIdentityAdmissionToken(context.runId, {
      contextId: context.contextId,
      executionId: context.executionId,
      now: context.createdAt,
    });
    const clear = persistingSink(database);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        recordDeviceLeaseDecision({
          token,
          phase: "release",
          releaseReason: "turn-end",
          deviceId: "device-a",
          rootSessionKey: "agent:main:root",
          agentId: "main",
          permissionMode: "workspace",
          leaseToken: "node-lease-token",
          occurredAt: 100,
        });
      }
    } finally {
      clear();
    }
    const opened = openOpenClawStateDatabase(database);
    const page = pageExecutionDecisionFactsForContextInDatabase(opened.db, {
      context: {
        contextId: context.contextId,
        executionId: context.executionId,
        runId: context.runId,
      },
      limit: 10,
      now: 100,
    });
    expect(page.receipts).toHaveLength(1);
    expect(page.receipts[0]?.decision.reasonCode).toBe("device_lease_turn_end");
    expect(page.receipts[0]?.decision.outcome).toBe("not-applicable");
  });

  it("writes nothing without an admitted execution token or with unbounded refs", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    const token = createExecutionIdentityAdmissionToken(context.runId, {
      contextId: context.contextId,
      executionId: context.executionId,
      now: context.createdAt,
    });
    const clear = persistingSink(database);
    try {
      expect(
        recordDeviceLeaseDecision({
          token: undefined,
          phase: "acquire",
          deviceId: "device-a",
          rootSessionKey: "agent:main:root",
        }),
      ).toBe(false);
      expect(
        recordDeviceLeaseDecision({
          token,
          phase: "reject",
          rejectReason: "occupied",
          deviceId: "x".repeat(4_097),
          rootSessionKey: "agent:main:root",
        }),
      ).toBe(false);
      expect(
        recordDeviceLeaseDecision({
          token,
          phase: "release",
          deviceId: "device-a",
          rootSessionKey: "agent:main:root",
        }),
      ).toBe(false);
      expect(
        recordDeviceLeaseDecision({
          token,
          phase: "reject",
          deviceId: "device-a",
          rootSessionKey: "agent:main:root",
        }),
      ).toBe(false);
    } finally {
      clear();
    }
    const opened = openOpenClawStateDatabase(database);
    expect(
      pageExecutionDecisionFactsForContextInDatabase(opened.db, {
        context: {
          contextId: context.contextId,
          executionId: context.executionId,
          runId: context.runId,
        },
        limit: 10,
        now: 100,
      }).receipts,
    ).toHaveLength(0);
  });

  it("accepts a maximally bounded device ref while staying inside the 16 KiB receipt bound", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    const token = createExecutionIdentityAdmissionToken(context.runId, {
      contextId: context.contextId,
      executionId: context.executionId,
      now: context.createdAt,
    });
    const clear = persistingSink(database);
    try {
      expect(
        recordDeviceLeaseDecision({
          token,
          phase: "acquire",
          deviceId: "d".repeat(4_096),
          rootSessionKey: "agent:main:root",
          leaseToken: "t".repeat(4_096),
          occurredAt: 100,
        }),
      ).toBe(true);
    } finally {
      clear();
    }
    const opened = openOpenClawStateDatabase(database);
    const page = pageExecutionDecisionFactsForContextInDatabase(opened.db, {
      context: {
        contextId: context.contextId,
        executionId: context.executionId,
        runId: context.runId,
      },
      limit: 10,
      now: 100,
    });
    expect(page.receipts).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(page.receipts[0]), "utf8")).toBeLessThanOrEqual(
      16 * 1024,
    );
  });

  it("expires with the generic decision-fact retention", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    const token = createExecutionIdentityAdmissionToken(context.runId, {
      contextId: context.contextId,
      executionId: context.executionId,
      now: context.createdAt,
    });
    const clear = persistingSink(database);
    try {
      recordDeviceLeaseDecision({
        token,
        phase: "acquire",
        deviceId: "device-a",
        rootSessionKey: "agent:main:root",
        occurredAt: 100,
      });
    } finally {
      clear();
    }
    const opened = openOpenClawStateDatabase(database);
    const ctx = {
      contextId: context.contextId,
      executionId: context.executionId,
      runId: context.runId,
    };
    expect(
      pageExecutionDecisionFactsForContextInDatabase(opened.db, {
        context: ctx,
        limit: 10,
        now: 100,
      }).receipts,
    ).toHaveLength(1);
    const pruned = pruneExpiredExecutionDecisionFactsInDatabase({
      now: 100 + RETENTION_MS + 1,
      database: { ...database, database: opened },
    });
    expect(pruned).toBe(1);
    expect(
      pageExecutionDecisionFactsForContextInDatabase(opened.db, {
        context: ctx,
        limit: 10,
        now: 100 + RETENTION_MS + 1,
      }).receipts,
    ).toHaveLength(0);
  });

  it("persists token-less reject receipt ids with the keyed projection and deduplicates replays", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    const token = createExecutionIdentityAdmissionToken(context.runId, {
      contextId: context.contextId,
      executionId: context.executionId,
      now: context.createdAt,
    });
    const clear = persistingSink(database);
    try {
      // A disabled-device reject carries no lease token, so its identity tuple
      // is only the low-entropy device id; the persisted id must be keyed.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(
          recordDeviceLeaseDecision({
            token,
            phase: "reject",
            rejectReason: "disabled",
            deviceId: "device-a",
            rootSessionKey: "agent:main:root",
            occurredAt: 100,
          }),
        ).toBe(true);
      }
    } finally {
      clear();
    }
    const opened = openOpenClawStateDatabase(database);
    const page = pageExecutionDecisionFactsForContextInDatabase(opened.db, {
      context: {
        contextId: context.contextId,
        executionId: context.executionId,
        runId: context.runId,
      },
      limit: 10,
      now: 100,
    });
    expect(page.receipts).toHaveLength(1);
    const receipt = page.receipts[0]!;
    expect(receipt.receiptId).toMatch(/^device-lease:hmac-sha256:v1:[a-f0-9]{32}:[a-f0-9]{64}$/u);
    expect(receipt.source.recordRef).toBe(receipt.receiptId);
    const retained = JSON.stringify(page.receipts);
    expect(retained).not.toContain("device-a");
    expect(retained).not.toContain("agent:main:root");
  });

  it("keys the same token-less reject differently per installation and keeps devices distinct", () => {
    const databaseA = databaseOptions();
    const databaseB = databaseOptions();
    const contextA = seedExecutionContext(databaseA);
    const contextB = seedExecutionContext(databaseB);
    const tokenA = createExecutionIdentityAdmissionToken(contextA.runId, {
      contextId: contextA.contextId,
      executionId: contextA.executionId,
      now: contextA.createdAt,
    });
    const tokenB = createExecutionIdentityAdmissionToken(contextB.runId, {
      contextId: contextB.contextId,
      executionId: contextB.executionId,
      now: contextB.createdAt,
    });
    const recordAll = (database: typeof databaseA, token: typeof tokenA) => {
      const clear = persistingSink(database);
      try {
        for (const deviceId of ["device-a", "device-b"]) {
          recordDeviceLeaseDecision({
            token,
            phase: "reject",
            rejectReason: "disconnected",
            deviceId,
            rootSessionKey: "agent:main:root",
            occurredAt: 100,
          });
        }
      } finally {
        clear();
      }
    };
    recordAll(databaseA, tokenA);
    recordAll(databaseB, tokenB);
    const idsFor = (database: typeof databaseA, context: typeof contextA) =>
      pageExecutionDecisionFactsForContextInDatabase(openOpenClawStateDatabase(database).db, {
        context: {
          contextId: context.contextId,
          executionId: context.executionId,
          runId: context.runId,
        },
        limit: 10,
        now: 100,
      }).receipts.map((receipt) => receipt.receiptId);
    const idsA = idsFor(databaseA, contextA);
    const idsB = idsFor(databaseB, contextB);
    // Two devices rejected in one execution stay two facts.
    expect(idsA).toHaveLength(2);
    expect(new Set(idsA).size).toBe(2);
    // The same transition under another installation key projects differently.
    expect(idsA[0]).not.toBe(idsB[0]);
    expect(idsA[1]).not.toBe(idsB[1]);
  });
});

describe("tool action device scope projection facts", () => {
  it("hashes the device id with the security-event convention", () => {
    expect(hashAuditDeviceRef("device-a")).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(hashAuditDeviceRef("  ")).toBeUndefined();
    expect(hashAuditDeviceRef(undefined)).toBeUndefined();
  });

  it("publishes, reads, and clears the session placement scope", () => {
    publishToolActionDeviceScope({
      sessionKey: "agent:main:root",
      deviceId: "device-a",
    });
    expect(readToolActionDeviceRef("agent:main:root")).toBe(hashAuditDeviceRef("device-a"));
    // Session keys keep their case; another session reads nothing.
    expect(readToolActionDeviceRef("AGENT:MAIN:ROOT")).toBeUndefined();
    expect(readToolActionDeviceRef(undefined)).toBeUndefined();
    publishToolActionDeviceScope({
      sessionKey: "agent:main:root",
      deviceId: null,
    });
    expect(readToolActionDeviceRef("agent:main:root")).toBeUndefined();
  });

  it("keeps a bounded registry with insert-order eviction", () => {
    for (let index = 0; index < 1_030; index += 1) {
      publishToolActionDeviceScope({
        sessionKey: `agent:main:s-${index}`,
        deviceId: `device-${index}`,
      });
    }
    expect(readToolActionDeviceRef("agent:main:s-0")).toBeUndefined();
    expect(readToolActionDeviceRef("agent:main:s-1029")).toBe(hashAuditDeviceRef("device-1029"));
  });
});
