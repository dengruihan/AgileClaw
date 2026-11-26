import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCronRunExecSource } from "../infra/cron-run-exec-source.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import type { BoundWebPushSubscription } from "../infra/push-web.js";
import { createEventWebPushDelivery } from "./event-web-push.js";

const mocks = vi.hoisted(() => ({
  pairedDevices: [] as PairedDevice[],
  listSubscriptions: vi.fn(),
  hasBoundSubscriptions: vi.fn(),
  prepareSender: vi.fn(),
  preparedSend: vi.fn(),
  prepareSessionFacts: vi.fn(),
  getUserPreferences: vi.fn(),
  canReceiveSessionEvent: vi.fn(),
}));

vi.mock("../infra/device-pairing-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing-worker.js")>()),
  withCurrentDevicePairingSnapshot: async <T>(
    _stateDir: string | undefined,
    prepare: (paired: PairedDevice[]) => { start: () => T } | undefined,
    _preparePublication?: () => Promise<void>,
  ) => prepare(mocks.pairedDevices)?.start(),
}));

vi.mock("../infra/push-web.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/push-web.js")>()),
  withBoundWebPushSubscriptions: async <T>(
    stateDir: string | undefined,
    prepare: (
      subscriptions: BoundWebPushSubscription[],
      assertCurrent: () => void,
    ) =>
      | { start: () => T | Promise<T> }
      | undefined
      | Promise<{ start: () => T | Promise<T> } | undefined>,
  ) => await (await prepare(await mocks.listSubscriptions(stateDir), () => {}))?.start(),
  hasBoundWebPushSubscriptions: mocks.hasBoundSubscriptions,
  prepareWebPushNotificationSender: mocks.prepareSender,
}));

vi.mock("../state/user-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-preferences.js")>()),
  getUserPreferenceValues: mocks.getUserPreferences,
}));

vi.mock("./session-sharing-preparation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-sharing-preparation.js")>()),
  prepareSessionMutationFacts: mocks.prepareSessionFacts,
}));

vi.mock("./session-sharing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-sharing.js")>()),
  canReceiveSessionEvent: mocks.canReceiveSessionEvent,
}));

function boundSubscription(deviceId: string): BoundWebPushSubscription {
  return {
    subscriptionId: `subscription-${deviceId}`,
    endpoint: `https://push.example.test/${deviceId}`,
    keys: { p256dh: `p256dh-${deviceId}`, auth: `auth-${deviceId}` },
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId,
    userProfileId: null,
    devicePreferences: {
      enabled: true,
      label: "",
      detailLevel: "identified",
      categories: {
        agentFinished: true,
        agentQuestion: true,
        humanMentioned: true,
        scheduledTaskFailed: true,
      },
    },
  };
}

function pairedOperator(deviceId: string): PairedDevice {
  const scopes = ["operator.read"];
  return {
    deviceId,
    publicKey: `public-key-${deviceId}`,
    roles: ["operator"],
    role: "operator",
    scopes,
    approvedScopes: scopes,
    tokens: {
      operator: { token: `token-${deviceId}`, role: "operator", scopes, createdAtMs: 1 },
    },
    createdAtMs: 1,
    approvedAtMs: 1,
  };
}

/** Stubs the prepared sharing facts that the authority owner hands to delivery. */
function prepareSessionTitleFacts(
  rows: Readonly<Record<string, { entry?: Record<string, unknown>; storeKey?: string }>>,
) {
  mocks.prepareSessionFacts.mockImplementation(
    async (request: { sessionKey: string; agentId?: string }) => ({
      readCurrent: () => {
        const row = rows[request.sessionKey];
        const storeKey = row?.storeKey ?? request.sessionKey;
        return {
          target: row?.entry
            ? {
                agentId: request.agentId ?? "research",
                canonicalKey: storeKey,
                storeKey,
                storeKeys: [storeKey],
                storePath: "/openclaw-test/stores/research.sqlite",
                entry: row.entry,
              }
            : null,
          membership: new Set<string>(),
        };
      },
      release: () => {},
    }),
  );
}

function deliverChat(
  payload: Record<string, unknown>,
  opts?: { sessionKeys?: string[]; agentId?: string },
): void {
  createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent("chat", payload, opts);
}

describe("event Web Push completion and failure copy", () => {
  const completedSession = {
    "agent:research:thread.1": {
      entry: { sessionId: "session-1", updatedAt: 1, displayName: "Quarterly invoice follow-up" },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pairedDevices = [pairedOperator("browser-device")];
    mocks.listSubscriptions.mockResolvedValue([boundSubscription("browser-device")]);
    mocks.hasBoundSubscriptions.mockResolvedValue(true);
    mocks.prepareSender.mockResolvedValue(mocks.preparedSend);
    mocks.preparedSend.mockResolvedValue([]);
    mocks.getUserPreferences.mockResolvedValue({ values: new Map(), isCurrent: () => true });
    mocks.canReceiveSessionEvent.mockReturnValue(true);
    mocks.prepareSessionFacts.mockResolvedValue({
      readCurrent: () => ({ target: null, membership: new Set<string>() }),
      release: () => {},
    });
  });

  it.each([
    {
      state: "final",
      detailLevel: "private",
      title: "AgileClaw agent finished",
      body: "An agent completed its response.",
      tag: "openclaw-agent-finished-run-1",
      urgency: "normal",
    },
    {
      state: "final",
      detailLevel: "identified",
      title: "Quarterly invoice follow-up",
      body: "Task completed.",
      tag: "openclaw-agent-finished-run-1",
      urgency: "normal",
    },
    {
      state: "final",
      detailLevel: "detailed",
      title: "Quarterly invoice follow-up",
      body: "Task completed.",
      tag: "openclaw-agent-finished-run-1",
      urgency: "normal",
    },
    {
      state: "error",
      detailLevel: "private",
      title: "AgileClaw agent failed",
      body: "An agent run failed.",
      tag: "openclaw-agent-failed-run-1",
      urgency: "high",
    },
    {
      state: "error",
      detailLevel: "identified",
      title: "Quarterly invoice follow-up",
      body: "Task failed: The model stopped responding.",
      tag: "openclaw-agent-failed-run-1",
      urgency: "high",
    },
    {
      state: "error",
      detailLevel: "detailed",
      title: "Quarterly invoice follow-up",
      body: "Task failed: The model stopped responding.",
      tag: "openclaw-agent-failed-run-1",
      urgency: "high",
    },
  ] as const)(
    "sends $detailLevel $state copy for the completed session",
    async ({ state, detailLevel, title, body, tag, urgency }) => {
      const subscription = boundSubscription("browser-device");
      subscription.devicePreferences.detailLevel = detailLevel;
      mocks.listSubscriptions.mockResolvedValue([subscription]);
      prepareSessionTitleFacts(completedSession);

      deliverChat(
        state === "final"
          ? { state: "final", runId: "run-1", sessionKey: "agent:research:thread.1" }
          : {
              state: "error",
              runId: "run-1",
              sessionKey: "agent:research:thread.1",
              errorMessage: "The model stopped responding.",
            },
        { sessionKeys: ["agent:research:thread.1"], agentId: "research" },
      );

      await vi.waitFor(() => expect(mocks.preparedSend).toHaveBeenCalledOnce());
      expect(mocks.preparedSend).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ title, body, tag, renotify: false }),
          deliveryOptions: expect.objectContaining({ urgency }),
        }),
      );
    },
  );

  it("falls back to the generic title when the completion scope has no prepared facts", async () => {
    deliverChat({
      state: "final",
      runId: "run-1",
      sessionKey: "agent:research:thread.1",
    });

    await vi.waitFor(() => expect(mocks.preparedSend).toHaveBeenCalledOnce());
    expect(mocks.preparedSend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          title: "AgileClaw agent finished",
          body: "Task completed.",
        }),
      }),
    );
  });

  it("keeps the generic title when a completion spans more than one session row", async () => {
    prepareSessionTitleFacts({
      "agent:research:thread.1": {
        entry: { sessionId: "session-1", updatedAt: 1, displayName: "First session" },
      },
      "agent:research:thread.2": {
        entry: { sessionId: "session-2", updatedAt: 1, displayName: "Second session" },
      },
    });

    deliverChat(
      { state: "final", runId: "run-1", sessionKey: "agent:research:thread.1" },
      {
        sessionKeys: ["agent:research:thread.1", "agent:research:thread.2"],
        agentId: "research",
      },
    );

    await vi.waitFor(() => expect(mocks.preparedSend).toHaveBeenCalledOnce());
    expect(mocks.preparedSend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ title: "AgileClaw agent finished" }),
      }),
    );
  });

  it("uses one canonical title when scoped and unscoped keys address the same session row", async () => {
    prepareSessionTitleFacts({
      "agent:research:thread.1": {
        entry: { sessionId: "session-1", updatedAt: 1, displayName: "Quarterly invoice follow-up" },
        storeKey: "agent:research:thread.1",
      },
      "thread.1": {
        entry: { sessionId: "session-1", updatedAt: 1, displayName: "Quarterly invoice follow-up" },
        storeKey: "agent:research:thread.1",
      },
    });

    deliverChat(
      { state: "final", runId: "run-1", sessionKey: "agent:research:thread.1" },
      { sessionKeys: ["agent:research:thread.1", "thread.1"], agentId: "research" },
    );

    await vi.waitFor(() => expect(mocks.preparedSend).toHaveBeenCalledOnce());
    expect(mocks.preparedSend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ title: "Quarterly invoice follow-up" }),
      }),
    );
  });

  it.each([
    {
      name: "control characters",
      displayName: "Line\nOne\u202E",
      expected: "Line One",
    },
    {
      name: "the push label bound",
      displayName: "🦞".repeat(60),
      expected: "🦞".repeat(40),
    },
  ])("sanitizes the session title against $name", async ({ displayName, expected }) => {
    prepareSessionTitleFacts({
      "agent:research:thread.1": { entry: { sessionId: "session-1", updatedAt: 1, displayName } },
    });

    deliverChat(
      { state: "final", runId: "run-1", sessionKey: "agent:research:thread.1" },
      { sessionKeys: ["agent:research:thread.1"], agentId: "research" },
    );

    await vi.waitFor(() => expect(mocks.preparedSend).toHaveBeenCalledOnce());
    expect(mocks.preparedSend).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ title: expected }) }),
    );
  });

  it("redacts secrets in the session title", async () => {
    prepareSessionTitleFacts({
      "agent:research:thread.1": {
        entry: {
          sessionId: "session-1",
          updatedAt: 1,
          displayName: 'Deploy API_SECRET="sk-abc123456789012345678"',
        },
      },
    });

    deliverChat(
      { state: "final", runId: "run-1", sessionKey: "agent:research:thread.1" },
      { sessionKeys: ["agent:research:thread.1"], agentId: "research" },
    );

    await vi.waitFor(() => expect(mocks.preparedSend).toHaveBeenCalledOnce());
    const title = mocks.preparedSend.mock.calls[0]?.[0].payload.title as string;
    expect(title).toContain("Deploy");
    expect(title).not.toContain("sk-abc123456789012345678");
  });

  it.each<{ name: string; errorMessage?: string; expected: string; absent?: string }>([
    {
      name: "a provider payload",
      errorMessage:
        'HTTP 401: {"error":{"type":"invalid_api_key","message":"Incorrect API key provided: sk-abc123456789012345678"}}',
      expected: "Task failed: HTTP 401 invalid_api_key: Incorrect API key provided: sk-abc…5678",
      absent: "sk-abc123456789012345678",
    },
    {
      name: "an HTML error page",
      errorMessage: "<!DOCTYPE html><html><body>Cloudflare Web server is down</body></html>",
      expected:
        "Task failed: Couldn't reach the AI service. Try again in a moment. If it continues, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
      absent: "<html",
    },
    {
      name: "an oversized reason",
      errorMessage: "x".repeat(400),
      expected: `Task failed: ${"x".repeat(160)}`,
    },
    {
      name: "control characters",
      errorMessage: "boom\nline2",
      expected: "Task failed: boom line2",
    },
    {
      name: "a blank reason",
      errorMessage: "   ",
      expected: "Task failed.",
    },
    {
      name: "a missing reason",
      errorMessage: undefined,
      expected: "Task failed.",
    },
  ])("formats $name in the failure body", async ({ errorMessage, expected, absent }) => {
    deliverChat(
      {
        state: "error",
        runId: "run-1",
        sessionKey: "agent:research:thread.1",
        ...(errorMessage === undefined ? {} : { errorMessage }),
      },
      { sessionKeys: ["agent:research:thread.1"], agentId: "research" },
    );

    await vi.waitFor(() => expect(mocks.preparedSend).toHaveBeenCalledOnce());
    const body = mocks.preparedSend.mock.calls[0]?.[0].payload.body as string;
    expect(body).toBe(expected);
    if (absent) {
      expect(body).not.toContain(absent);
    }
  });

  it("does not notify for an aborted run", async () => {
    deliverChat(
      {
        state: "aborted",
        runId: "run-1",
        sessionKey: "agent:research:thread.1",
        errorMessage: "Aborted by the operator.",
      },
      { sessionKeys: ["agent:research:thread.1"], agentId: "research" },
    );

    await Promise.resolve();
    expect(mocks.prepareSender).not.toHaveBeenCalled();
    expect(mocks.preparedSend).not.toHaveBeenCalled();
  });

  it("leaves a cron-linked run failure to the scheduled-task failure", async () => {
    const unregister = registerCronRunExecSource("cron-run-failed", {
      agentId: "research",
      jobId: "nightly",
      jobConfigRevision: "rev-1",
      jobName: "Nightly",
      notifyOnComplete: true,
    });
    try {
      const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });
      delivery.handleEvent(
        "chat",
        {
          state: "error",
          runId: "cron-run-failed",
          sessionKey: "agent:research:cron",
          errorMessage: "boom",
        },
        { agentId: "research" },
      );
      await Promise.resolve();
      expect(mocks.preparedSend).not.toHaveBeenCalled();

      delivery.handleEvent("cron", {
        action: "finished",
        jobId: "nightly",
        status: "error",
        runId: "cron-run-failed",
      });
      await vi.waitFor(() => expect(mocks.preparedSend).toHaveBeenCalledOnce());
      expect(mocks.preparedSend).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ tag: "openclaw-cron-failed-nightly" }),
        }),
      );
    } finally {
      unregister();
    }
  });
});
