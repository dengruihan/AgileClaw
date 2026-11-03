import { beforeEach, describe, expect, it } from "vitest";
import {
  clearVaultFillSession,
  hasActiveVaultFill,
  hasAnyActiveVaultFill,
  registerVaultFillSecret,
  scrubVaultFillText,
  scrubVaultFillValue,
} from "./vault-fill-scrub.js";

const CANARY = "canary-fill-0f9c2a7d";

describe("vault fill scrub", () => {
  beforeEach(() => {
    clearVaultFillSession("target-1");
    clearVaultFillSession("target-2");
  });

  it("fully masks raw, URL-encoded, JSON-escaped, and base64 values", () => {
    registerVaultFillSecret("target-1", CANARY);
    const encoded = encodeURIComponent(CANARY);
    const base64 = Buffer.from(CANARY, "utf8").toString("base64");
    const jsonEscaped = JSON.stringify(CANARY).slice(1, -1);
    const text = `raw=${CANARY} url=${encoded} b64=${base64} json=${jsonEscaped}`;
    const scrubbed = scrubVaultFillText("target-1", text);
    expect(scrubbed).not.toContain(CANARY);
    expect(scrubbed).not.toContain(encoded);
    expect(scrubbed).not.toContain(base64);
    expect(scrubbed).toContain("***");
  });

  it("scrubs nested tool results regardless of logging.redact", () => {
    registerVaultFillSecret("target-1", CANARY);
    const result = scrubVaultFillValue("target-1", {
      result: { value: CANARY, nested: [CANARY, "safe"] },
      content: [{ type: "text", text: `value ${CANARY}` }],
    });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(result.result.nested[1]).toBe("safe");
  });

  it("scopes masking to the target and expires the session", () => {
    registerVaultFillSecret("target-1", CANARY, { nowMs: 1_000, ttlMs: 5_000 });
    expect(scrubVaultFillText("target-2", CANARY, 1_000)).toBe(CANARY);
    expect(hasActiveVaultFill("target-1", 5_999)).toBe(true);
    expect(hasActiveVaultFill("target-1", 6_000)).toBe(false);
    expect(hasAnyActiveVaultFill(6_000)).toBe(false);
  });

  it("can be cleared explicitly on navigation or close", () => {
    registerVaultFillSecret("target-1", CANARY);
    expect(hasAnyActiveVaultFill()).toBe(true);
    clearVaultFillSession("target-1");
    expect(hasAnyActiveVaultFill()).toBe(false);
    expect(scrubVaultFillText("target-1", CANARY)).toBe(CANARY);
  });
});
