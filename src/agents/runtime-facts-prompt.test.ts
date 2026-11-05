import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import type { MediaGenerationOperation } from "./media-generation-activity.js";
import * as mediaActivity from "./media-generation-activity.js";
import {
  clearPromptDeviceScopeSnapshotsForTest,
  publishPromptDeviceScopeSnapshot,
} from "./prompt-device-scope.js";
import { buildRuntimeFactsContext } from "./runtime-facts-prompt.js";

const params = { capabilityToolNames: new Set(["exec"]), agentId: "main", cfg: {} };
afterEach(() => {
  vi.restoreAllMocks();
  clearPromptDeviceScopeSnapshotsForTest();
});

describe("approved executable runtime facts", () => {
  it("sorts current agent and wildcard hints, preserves paths and argument notes, and clears stale hints", () =>
    withMockedPlatform("win32", async () => {
      const file: execApprovals.ExecApprovalsFile = {
        version: 1,
        agents: {
          main: { allowlist: [{ pattern: "C:\\Tools\\z.exe", argPattern: "--version" }] },
          "*": { allowlist: [{ pattern: "C:\\Tools\\a.exe" }] },
          other: { allowlist: [{ pattern: "C:\\Private\\other.exe" }] },
        },
      };
      vi.spyOn(execApprovals, "loadExecApprovals").mockImplementation(() => file);
      const initial = await buildRuntimeFactsContext(params);
      expect(initial).toEqual([{ kind: "conversation-data", text: expect.any(String) }]);
      const before = initial.at(0)?.text;
      expect(before).toContain("## Approved executables");
      expect(before).toContain(
        "exact arguments are enforced at runtime; no approval prompt needed when args match",
      );
      expect(before).toContain(
        "C:\\Tools\\a.exe (any arguments)\n  C:\\Tools\\z.exe (restricted args)",
      );
      expect(before).not.toContain("other.exe");
      file.agents!.main!.allowlist!.unshift({ pattern: "C:\\Tools\\b.exe" });
      const added = (await buildRuntimeFactsContext(params)).at(0)?.text;
      expect(added).toContain("b.exe (any arguments)");
      file.agents!.main!.allowlist!.reverse();
      expect((await buildRuntimeFactsContext(params)).at(0)?.text).toBe(added);
      file.agents = {};
      expect(await buildRuntimeFactsContext(params)).toEqual([]);
      expect(
        (await buildRuntimeFactsContext({ ...params, includeEmptySnapshots: true })).at(0)?.text,
      ).toBe("## Approved executables\nnone");
    }));

  it("bounds hints and omits command approvals, global wildcards, bare names, and unsafe or oversized tokens", () =>
    withMockedPlatform("win32", async () => {
      vi.spyOn(execApprovals, "loadExecApprovals").mockReturnValue({
        version: 1,
        agents: {
          main: {
            allowlist: [
              ...[
                "*",
                "node",
                "=command:C:\\Tools\\node.exe --version",
                "C:\\bad\nname.exe",
                `C:\\${"x".repeat(300)}.exe`,
              ].map((pattern) => ({ pattern })),
              ...Array.from({ length: 12 }, (_, i) => ({
                pattern: `C:\\Tools\\app${String(i).padStart(2, "0")}.exe`,
              })).toReversed(),
            ],
          },
        },
      });
      const facts = expectDefined(
        (await buildRuntimeFactsContext(params)).at(0),
        "approved executable facts",
      ).text;
      expect(facts.match(/\(any arguments\)/g)).toHaveLength(10);
      expect(facts).toContain("app00.exe");
      expect(facts).toContain("app09.exe");
      expect(facts).not.toMatch(/app10|app11|=command:|bad|xxx/);
      expect(facts.length).toBeLessThan(3000);
    }));

  it.each(["linux", "win32"] as const)(
    "gates approval reads on Windows and exec capability: %s",
    (platform) =>
      withMockedPlatform(platform, async () => {
        const load = vi.spyOn(execApprovals, "loadExecApprovals").mockImplementation(() => {
          throw new Error("unavailable");
        });
        expect(
          await buildRuntimeFactsContext({ ...params, capabilityToolNames: new Set(["read"]) }),
        ).toEqual([]);
        expect(load).not.toHaveBeenCalled();
        const facts = (await buildRuntimeFactsContext(params)).at(0)?.text;
        if (platform === "win32") {
          expect(facts).toBe("## Approved executables\nunavailable");
        } else {
          expect(facts).toBeUndefined();
          expect(load).not.toHaveBeenCalled();
        }
      }),
  );
});

function createMediaTask(
  overrides: Partial<MediaGenerationOperation> = {},
): MediaGenerationOperation {
  return {
    taskId: "image-1",
    taskKind: "image_generation",
    sourceId: "image_generate:provider",
    requesterSessionKey: "agent:main:media",
    requesterAgentId: "main",
    task: "Generate media",
    status: "running",
    createdAt: 1,
    ...overrides,
  };
}

describe("media task runtime facts", () => {
  it("uses one native owner snapshot for enabled media and refreshes it next turn", async () => {
    const read = vi.spyOn(mediaActivity, "listMediaGenerationOperations");
    const mediaParams = {
      ...params,
      sessionKey: "agent:main:media",
      capabilityToolNames: new Set(["video_generate", "image_generate", "music_generate"]),
    };
    read.mockReturnValue([
      createMediaTask({
        taskId: "video-1",
        taskKind: "video_generation",
        sourceId: "video_generate",
        status: "queued",
      }),
      createMediaTask({ taskId: "other-agent", requesterAgentId: "other" }),
      createMediaTask({ progressSummary: "Rendering" }),
      createMediaTask({
        taskId: "music-1",
        taskKind: "music_generation",
        sourceId: "music_generate",
      }),
    ]);
    expect(await buildRuntimeFactsContext(mediaParams)).toEqual([
      {
        kind: "conversation-data",
        text: [
          "## Media Generation Tasks",
          '- tool=image_generate; task=image-1; status=running; provider_json="provider"; progress_json="Rendering"',
          "- tool=music_generate; task=music-1; status=running",
          "- tool=video_generate; task=video-1; status=queued",
        ].join("\n"),
      },
    ]);
    expect(read).toHaveBeenCalledExactlyOnceWith("agent:main:media", "main");

    read.mockReturnValue([]);
    expect(await buildRuntimeFactsContext(mediaParams)).toEqual([]);
    expect(await buildRuntimeFactsContext({ ...mediaParams, includeEmptySnapshots: true })).toEqual(
      [
        {
          kind: "conversation-data",
          text: [
            "## Media Generation Tasks",
            "- tool=image_generate; none",
            "- tool=music_generate; none",
            "- tool=video_generate; none",
          ].join("\n"),
        },
      ],
    );
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("includes only enabled media sections", async () => {
    const tools = ["music_generate", "video_generate"];
    const read = vi.spyOn(mediaActivity, "listMediaGenerationOperations").mockReturnValue([
      createMediaTask(),
      createMediaTask({
        taskId: "music-1",
        taskKind: "music_generation",
        sourceId: "music_generate",
      }),
    ]);
    expect(
      await buildRuntimeFactsContext({
        ...params,
        sessionKey: "agent:main:media",
        capabilityToolNames: new Set(tools),
      }),
    ).toEqual([
      {
        kind: "conversation-data",
        text: "## Media Generation Tasks\n- tool=music_generate; task=music-1; status=running",
      },
    ]);
    expect(
      await buildRuntimeFactsContext({
        ...params,
        sessionKey: "agent:main:media",
        capabilityToolNames: new Set(tools),
        includeEmptySnapshots: true,
      }),
    ).toEqual([
      {
        kind: "conversation-data",
        text: "## Media Generation Tasks\n- tool=music_generate; task=music-1; status=running\n- tool=video_generate; none",
      },
    ]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "", "   "])(
    "omits empty media facts without session %j unless retained",
    async (sessionKey) => {
      const read = vi.spyOn(mediaActivity, "listMediaGenerationOperations");
      expect(
        await buildRuntimeFactsContext({
          ...params,
          sessionKey,
          capabilityToolNames: new Set(["image_generate", "video_generate"]),
        }),
      ).toEqual([]);
      expect(
        await buildRuntimeFactsContext({
          ...params,
          sessionKey,
          capabilityToolNames: new Set(["image_generate", "video_generate"]),
          includeEmptySnapshots: true,
        }),
      ).toEqual([
        {
          kind: "conversation-data",
          text: "## Media Generation Tasks\n- tool=image_generate; none\n- tool=video_generate; none",
        },
      ]);
      expect(read).not.toHaveBeenCalled();
    },
  );
});

describe("device scope runtime facts", () => {
  const sessionKey = "agent:main:device-scope";
  const deviceScopeParams = {
    ...params,
    capabilityToolNames: new Set(["use_device"]),
    sessionKey,
  };

  it("renders the current scope and a sorted, sanitized enabled device list", async () => {
    publishPromptDeviceScopeSnapshot({
      sessionKey,
      snapshot: {
        target: { kind: "gateway", host: "gateway-host", os: "Linux 6.8", cwd: "/srv/ws" },
        devices: [
          { deviceId: "node-b", displayName: "Studio\nMac", platform: "darwin", connected: false },
          { deviceId: "node-a", displayName: "Kitchen", platform: "linux", connected: true },
          { deviceId: "node-c", enabled: false, connected: true },
        ],
      },
    });

    expect(await buildRuntimeFactsContext(deviceScopeParams)).toEqual([
      {
        kind: "conversation-data",
        text: [
          "## Device Scope",
          "Current scope device: gateway (host=gateway-host, os=Linux 6.8, cwd=/srv/ws)",
          "Enabled devices (max 10):",
          "- node-a (Kitchen): linux, connected",
          "- node-b (StudioMac): darwin, disconnected",
        ].join("\n"),
      },
    ]);
  });

  it("supersedes a node scope with explicit empty snapshots", async () => {
    publishPromptDeviceScopeSnapshot({
      sessionKey,
      snapshot: {
        target: { kind: "gateway", host: "gateway-host" },
        devices: [{ deviceId: "node-a", connected: true }],
      },
    });
    publishPromptDeviceScopeSnapshot({
      sessionKey,
      snapshot: {
        target: { kind: "node", deviceId: "node-a", displayName: "Kitchen", platform: "linux" },
        devices: [],
      },
    });

    expect(await buildRuntimeFactsContext(deviceScopeParams)).toEqual([
      {
        kind: "conversation-data",
        text: "## Device Scope\nCurrent scope device: node:node-a (Kitchen), os=linux, cwd=node default",
      },
    ]);
    expect(
      await buildRuntimeFactsContext({ ...deviceScopeParams, includeEmptySnapshots: true }),
    ).toEqual([
      {
        kind: "conversation-data",
        text: [
          "## Device Scope",
          "Current scope device: node:node-a (Kitchen), os=linux, cwd=node default",
          "Enabled devices (max 10):",
          "- none",
        ].join("\n"),
      },
    ]);
  });

  it("caps the enabled device list at ten lines and bounds every field", async () => {
    publishPromptDeviceScopeSnapshot({
      sessionKey,
      snapshot: {
        target: { kind: "node", deviceId: "node-00", cwd: "/Users/agent/ws" },
        devices: Array.from({ length: 13 }, (_, index) => ({
          deviceId: `node-${String(index).padStart(2, "0")}`,
          displayName: `Device ${index}`,
          platform: "x".repeat(200),
          connected: index % 2 === 0,
        })).toReversed(),
      },
    });

    const facts = expectDefined(
      (await buildRuntimeFactsContext(deviceScopeParams)).at(0),
      "device scope facts",
    ).text;

    expect(facts.match(/^- node-/gmu)).toHaveLength(10);
    expect(facts).toContain("- node-00 (Device 0): ");
    expect(facts).toContain("- node-09 (Device 9): ");
    expect(facts).not.toMatch(/node-1[0-2]/u);
    expect(facts).toContain("Current scope device: node:node-00, cwd=/Users/agent/ws");
    expect(facts.length).toBeLessThan(3000);
    expect(facts).not.toContain("x".repeat(65));
  });

  it("omits the family without the switching tool or a published snapshot", async () => {
    publishPromptDeviceScopeSnapshot({
      sessionKey,
      snapshot: { target: { kind: "gateway", host: "gateway-host" }, devices: [] },
    });

    expect(
      await buildRuntimeFactsContext({
        ...deviceScopeParams,
        capabilityToolNames: new Set(["exec"]),
      }),
    ).toEqual([]);
    expect(
      await buildRuntimeFactsContext({ ...deviceScopeParams, sessionKey: "agent:main:other" }),
    ).toEqual([]);
    expect(await buildRuntimeFactsContext({ ...deviceScopeParams, sessionKey: undefined })).toEqual(
      [],
    );
  });

  it("prefers a prepared turn scope and drops stale publications", async () => {
    expect(
      await buildRuntimeFactsContext({
        ...deviceScopeParams,
        deviceScope: {
          target: { kind: "gateway", host: "prepared-host" },
          devices: [{ deviceId: "node-a", connected: true }],
        },
      }),
    ).toEqual([
      {
        kind: "conversation-data",
        text: [
          "## Device Scope",
          "Current scope device: gateway (host=prepared-host)",
          "Enabled devices (max 10):",
          "- node-a: connected",
        ].join("\n"),
      },
    ]);

    publishPromptDeviceScopeSnapshot({
      sessionKey,
      snapshot: { target: { kind: "gateway", host: "stale-host" }, devices: [] },
      isCurrent: () => false,
    });
    expect(await buildRuntimeFactsContext(deviceScopeParams)).toEqual([]);
  });
});
