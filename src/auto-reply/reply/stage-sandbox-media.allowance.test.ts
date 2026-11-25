// Sandbox staging bounds: direct uploads own a larger admitted ceiling, so their
// copies follow it instead of the shared task-input allowance, and large local
// copies stream rather than buffering the whole file.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createSandboxMediaContexts,
  createSandboxMediaStageConfig,
  withSandboxMediaTempHome,
} from "../stage-sandbox-media.test-harness.js";
import {
  SANDBOX_MEDIA_MAX_BYTES,
  shouldStreamSandboxCopy,
  stageSandboxMedia,
} from "./stage-sandbox-media.js";

const sandboxMocks = vi.hoisted(() => ({ ensureSandboxWorkspaceForSession: vi.fn() }));
vi.mock("../../agents/sandbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/sandbox.js")>()),
  ensureSandboxWorkspaceForSession: sandboxMocks.ensureSandboxWorkspaceForSession,
}));
beforeEach(() => sandboxMocks.ensureSandboxWorkspaceForSession.mockReset());

it.each([
  { sizeBytes: SANDBOX_MEDIA_MAX_BYTES + 1, maxBytes: 1024 * 1024 * 1024, expected: true },
  { sizeBytes: SANDBOX_MEDIA_MAX_BYTES + 1, maxBytes: SANDBOX_MEDIA_MAX_BYTES, expected: false },
  { sizeBytes: 100, maxBytes: 1024 * 1024 * 1024, expected: false },
])("shouldStreamSandboxCopy(%o) => $expected", ({ sizeBytes, maxBytes, expected }) => {
  expect(shouldStreamSandboxCopy({ sizeBytes, maxBytes })).toBe(expected);
});

it.each([
  { allowance: 100, staged: false },
  { allowance: 400, staged: true },
])(
  "applies the per-input allowance $allowance instead of buffering a larger file",
  async ({ allowance, staged }) => {
    await withSandboxMediaTempHome("openclaw-staged-allowance-", async (home) => {
      const source = path.join(home, ".openclaw", "media", "inbound", "synthetic-input.bin");
      const payload = Buffer.alloc(200, 7);
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(source, payload);
      const workspaceDir = path.join(home, "workspace");
      const sandboxDir = path.join(home, "sandbox");
      sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue({
        workspaceDir: sandboxDir,
        containerWorkdir: "/work",
      });
      const { ctx, sessionCtx } = createSandboxMediaContexts(source);
      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg: createSandboxMediaStageConfig(home),
        sessionKey: "agent:main:main",
        workspaceDir,
        maxBytesByIndex: new Map([[0, allowance]]),
      });
      if (!staged) {
        expect(result.staged.size).toBe(0);
        await expect(fs.stat(path.join(sandboxDir, "media"))).rejects.toThrow();
        return;
      }
      const stagedPath = result.staged.get(0)!;
      expect(await fs.readFile(path.join(sandboxDir, stagedPath))).toEqual(payload);
    });
  },
);
