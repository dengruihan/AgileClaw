// logging.redact mode tests: the config switch that disables pattern-based
// sensitive-value redaction while registered exact-value masking stays on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { redactSourceInputTextWithConfig } from "./redact-source.js";
import {
  prepareModelVisibleToolTextBlock,
  redactModelVisibleToolPayloadText,
  redactSecrets,
  redactSensitiveText,
  redactToolPayloadTextWithConfig,
} from "./redact.js";
import { registerSecretValueForRedaction } from "./secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "./secret-redaction-registry.test-support.js";

let tempDirs: string[] = [];

function writeConfig(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-redact-mode-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, source);
  return configPath;
}

afterEach(() => {
  resetSecretRedactionRegistryForTest();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe("logging.redact mode", () => {
  const assignmentPayload = "token=abcdef1234567890ghij";
  const sourcePayload = 'const API_TOKEN = "fixture-only-not-a-real-secret"; return API_TOKEN;';

  it("disables pattern redaction across log, tool, and source surfaces when off", () => {
    const configPath = writeConfig(`{
      logging: {
        redact: "off",
      },
    }`);

    withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () => {
      expect(redactSensitiveText(assignmentPayload)).toBe(assignmentPayload);
      expect(redactToolPayloadTextWithConfig(assignmentPayload)).toBe(assignmentPayload);
      expect(redactModelVisibleToolPayloadText(sourcePayload)).toBe(sourcePayload);
      expect(redactSourceInputTextWithConfig(sourcePayload)).toBe(sourcePayload);
      expect(redactSecrets({ detail: assignmentPayload })).toEqual({
        detail: assignmentPayload,
      });
    });
  });

  it("keeps registered exact-value masking while mode is off", () => {
    const secret = "sk-registeredfloor1234567890";
    registerSecretValueForRedaction(secret);
    const configPath = writeConfig(`{
      logging: {
        redact: "off",
      },
    }`);

    withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () => {
      expect(redactSensitiveText(`echo ${secret} ${assignmentPayload}`)).toBe(
        `echo sk-reg…7890 ${assignmentPayload}`,
      );
    });
  });

  it("re-prepares model-visible tool text when the redact mode flips", () => {
    const block = { type: "text", text: "Authorization: Bearer abcdef1234567890ghij" };
    expect(prepareModelVisibleToolTextBlock(block, {}).text).toBe(
      "Authorization: Bearer abcdef…ghij",
    );
    expect(prepareModelVisibleToolTextBlock(block, { redact: "off" }).text).toBe(block.text);
  });

  it("treats an explicit tools mode the same as the default", () => {
    const configPath = writeConfig(`{
      logging: {
        redact: "tools",
      },
    }`);

    withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () => {
      expect(redactSensitiveText(assignmentPayload)).toBe("token=abcdef…ghij");
    });
  });
});
