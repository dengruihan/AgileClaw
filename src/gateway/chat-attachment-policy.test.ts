// Attachment policy tests guard the numbers advertised on `hello-ok` against the
// ceilings the parser actually enforces. The per-file ceiling is not a frame
// budget: files above what one frame can carry stream through the direct upload
// route, so the advertised value stays at the full decoded ceiling.
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_CHAT_ATTACHMENT_MAX_BYTES,
  resolveChatAttachmentMaxBytes,
  resolveChatAttachmentPolicy,
} from "./chat-attachment-policy.js";

const MB = 1024 * 1024;

const cfgWithMediaMaxMb = (value: unknown): OpenClawConfig =>
  ({ agents: { defaults: { mediaMaxMb: value } } }) as unknown as OpenClawConfig;

describe("resolveChatAttachmentMaxBytes", () => {
  it("defaults to 1 GiB per file", () => {
    expect(DEFAULT_CHAT_ATTACHMENT_MAX_BYTES).toBe(1024 * MB);
    expect(resolveChatAttachmentMaxBytes({} as OpenClawConfig)).toBe(1024 * MB);
    expect(resolveChatAttachmentMaxBytes({ agents: {} } as unknown as OpenClawConfig)).toBe(
      1024 * MB,
    );
  });

  it("honors a configured ceiling exactly at the 1 GiB boundary", () => {
    expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(1024))).toBe(1024 * MB);
    expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(1024.000001))).toBe(1024 * MB + 1);
  });

  it("rejects non-positive, non-finite, or non-number values", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "50", null, undefined]) {
      expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(bad))).toBe(
        DEFAULT_CHAT_ATTACHMENT_MAX_BYTES,
      );
    }
  });

  it("never floors a legal sub-byte mediaMaxMb to zero", () => {
    expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(0.0000001))).toBe(1);
  });

  it("keeps an enormous mediaMaxMb representable instead of overflowing", () => {
    expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(1e308))).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("resolveChatAttachmentPolicy", () => {
  it("advertises the decoded per-file ceiling, not one frame's base64 budget", () => {
    const policy = resolveChatAttachmentPolicy({} as OpenClawConfig);
    expect(policy.maxBytes).toBe(1024 * MB);
    // 1 GiB of base64 far exceeds one 25 MiB frame; the direct upload route
    // carries these bytes instead, so the frame budget must not truncate it.
    expect(policy.maxBytes).toBeGreaterThan(25 * MB);
    expect(Number.isSafeInteger(policy.maxBytes)).toBe(true);
  });

  it("follows a configured ceiling above 1 GiB", () => {
    expect(resolveChatAttachmentPolicy(cfgWithMediaMaxMb(2048)).maxBytes).toBe(2048 * MB);
  });

  it("keeps the image ceiling at the agent-hydration cap", () => {
    expect(resolveChatAttachmentPolicy({} as OpenClawConfig).maxImageBytes).toBe(MAX_IMAGE_BYTES);
  });

  it("keeps both ceilings positive so the hello-ok schema stays satisfiable", () => {
    const policy = resolveChatAttachmentPolicy(cfgWithMediaMaxMb(0.0000001));
    expect(policy.maxBytes).toBeGreaterThanOrEqual(1);
    expect(policy.maxImageBytes).toBeGreaterThanOrEqual(1);
  });
});
