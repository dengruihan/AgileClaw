import { afterEach, describe, expect, it, vi } from "vitest";
import { humanControlRegistry } from "./human-control.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";
import {
  clearAllVaultFillSessions,
  hasActiveVaultFill,
  registerVaultFillSecret,
} from "./vault-fill-scrub.js";

const pwAiMocks = vi.hoisted(() => {
  const closePlaywrightBrowserConnection = vi.fn(async (_opts?: { cdpUrl?: string }) => {});
  return {
    closePlaywrightBrowserConnection,
    retirePlaywrightBrowserConnectionExact: vi.fn((opts: { cdpUrl: string }) => ({
      retired: true,
      close: async () => await closePlaywrightBrowserConnection(opts),
    })),
  };
});

const chromeMocks = vi.hoisted(() => ({
  stopOwnedOpenClawChrome: vi.fn<typeof import("./chrome.js").stopOwnedOpenClawChrome>(
    async () => ({ status: "not-running" }),
  ),
}));

vi.mock("./pw-ai.js", () => ({ pwAi: pwAiMocks }));
vi.mock("./chrome.js", () => ({
  isChromeCdpOwnedByPid: vi.fn(async () => true),
  isChromeCdpReady: vi.fn(async () => true),
  isChromeReachable: vi.fn(async () => true),
  launchOpenClawChrome: vi.fn(async () => {
    throw new Error("unexpected launch");
  }),
  resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw-test"),
  stopOwnedOpenClawChrome: chromeMocks.stopOwnedOpenClawChrome,
  stopOpenClawChrome: vi.fn(async () => {}),
}));
vi.mock("./chrome-mcp.js", () => ({
  closeChromeMcpSession: vi.fn(async () => false),
  countChromeMcpTabs: vi.fn(async () => 0),
  ensureChromeMcpAvailable: vi.fn(async () => {}),
  listChromeMcpTabs: vi.fn(async () => []),
}));

afterEach(() => {
  vi.clearAllMocks();
  chromeMocks.stopOwnedOpenClawChrome.mockResolvedValue({ status: "not-running" });
});

function createStopHarness(profile: ReturnType<typeof makeBrowserProfile>) {
  const state = makeBrowserServerState({ profile });
  const ctx = createBrowserRouteContext({ getState: () => state });
  return { profileCtx: ctx.forProfile(profile.name) };
}

describe("createProfileAvailability.stopRunningBrowser", () => {
  it.each([
    { name: "attach-only", overrides: { attachOnly: true } },
    {
      name: "remote",
      overrides: {
        cdpUrl: "http://10.0.0.5:9222",
        cdpHost: "10.0.0.5",
        cdpIsLoopback: false,
        cdpPort: 9222,
      },
    },
  ])(
    "stops an unused $name profile without loading Playwright or terminating Chrome",
    async ({ overrides }) => {
      const { profileCtx } = createStopHarness(makeBrowserProfile(overrides));
      await expect(profileCtx.stopRunningBrowser()).resolves.toEqual({ stopped: true });
      expect(pwAiMocks.closePlaywrightBrowserConnection).not.toHaveBeenCalled();
      expect(chromeMocks.stopOwnedOpenClawChrome).not.toHaveBeenCalled();
    },
  );

  it("clears this profile's leases and masking after a confirmed managed stop", async () => {
    humanControlRegistry.revokeAll();
    clearAllVaultFillSessions();
    chromeMocks.stopOwnedOpenClawChrome.mockResolvedValue({ status: "stopped" });
    const { profileCtx } = createStopHarness(makeBrowserProfile());
    const name = profileCtx.profile.name;
    humanControlRegistry.claim({
      profile: name,
      targetId: "target-stop",
      tabId: "t1",
      reason: "user_request",
      requestedBy: "human",
    });
    registerVaultFillSecret("target-stop", "stop-canary", "doc-stop", name);
    registerVaultFillSecret("target-other", "other-canary", "doc-other", "other-profile");

    await profileCtx.stopRunningBrowser();

    expect(
      humanControlRegistry.status({ profile: name, targetId: "target-stop", tabId: "t1" }),
    ).toBeNull();
    expect(hasActiveVaultFill("target-stop")).toBe(false);
    expect(hasActiveVaultFill("target-other")).toBe(true);
    clearAllVaultFillSessions();
    humanControlRegistry.revokeAll();
  });

  it.each([
    {
      name: "attach-only detachment",
      overrides: { attachOnly: true },
      status: "not-running" as const,
    },
    { name: "unverified managed stop", overrides: {}, status: "unverified" as const },
    { name: "not-running managed browser", overrides: {}, status: "not-running" as const },
  ])(
    "keeps masking when $name cannot prove the document is gone",
    async ({ overrides, status }) => {
      humanControlRegistry.revokeAll();
      clearAllVaultFillSessions();
      chromeMocks.stopOwnedOpenClawChrome.mockResolvedValue({
        status,
        ...(status === "unverified" ? { reason: "process identity changed" } : {}),
      });
      const { profileCtx } = createStopHarness(makeBrowserProfile(overrides));
      const name = profileCtx.profile.name;
      humanControlRegistry.claim({
        profile: name,
        targetId: "target-survives",
        tabId: "t1",
        reason: "user_request",
        requestedBy: "human",
      });
      registerVaultFillSecret("target-survives", "survives-canary", "doc-survives", name);

      await profileCtx.stopRunningBrowser();

      expect(
        humanControlRegistry.status({ profile: name, targetId: "target-survives", tabId: "t1" }),
      ).not.toBeNull();
      expect(hasActiveVaultFill("target-survives")).toBe(true);
      clearAllVaultFillSessions();
      humanControlRegistry.revokeAll();
    },
  );

  it.each(["not-running", "stopped"] as const)(
    "reports the managed Chrome owner result: %s",
    async (status) => {
      chromeMocks.stopOwnedOpenClawChrome.mockResolvedValue({ status });
      const { profileCtx } = createStopHarness(makeBrowserProfile());
      await expect(profileCtx.stopRunningBrowser()).resolves.toEqual({
        stopped: status === "stopped",
      });
      expect(chromeMocks.stopOwnedOpenClawChrome).toHaveBeenCalledOnce();
      expect(pwAiMocks.closePlaywrightBrowserConnection).not.toHaveBeenCalled();
    },
  );

  it.each(["existing-session", "extension"] as const)(
    "does not terminate a personal %s browser",
    async (driver) => {
      const { profileCtx } = createStopHarness(makeBrowserProfile({ driver }));
      await profileCtx.stopRunningBrowser();
      expect(chromeMocks.stopOwnedOpenClawChrome).not.toHaveBeenCalled();
    },
  );
});
