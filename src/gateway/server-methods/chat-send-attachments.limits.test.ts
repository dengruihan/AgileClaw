// Sandbox staging allowance: a direct upload was already admitted against the
// advertised per-file ceiling, so the shared 50 MiB task-input budget must not
// apply a hidden lower limit before `chat.send` accepts it.
import { describe, expect, it } from "vitest";
import { resolveSandboxStageMaxBytes } from "./chat-send-attachments.js";

const SHARED = 50 * 1024 * 1024;
const CEILING = 1024 * 1024 * 1024;

describe("resolveSandboxStageMaxBytes", () => {
  it("follows the advertised ceiling for direct uploads", () => {
    expect(
      resolveSandboxStageMaxBytes({
        directUpload: true,
        chatAttachmentMaxBytes: CEILING,
        sharedMaxBytes: SHARED,
      }),
    ).toBe(CEILING);
  });

  it("keeps the shared task-input allowance for inline attachments", () => {
    expect(
      resolveSandboxStageMaxBytes({
        directUpload: false,
        chatAttachmentMaxBytes: CEILING,
        sharedMaxBytes: SHARED,
      }),
    ).toBe(SHARED);
  });

  it("lets a configured ceiling below the shared allowance narrow staging", () => {
    expect(
      resolveSandboxStageMaxBytes({
        directUpload: true,
        chatAttachmentMaxBytes: 10 * 1024 * 1024,
        sharedMaxBytes: SHARED,
      }),
    ).toBe(10 * 1024 * 1024);
  });
});
