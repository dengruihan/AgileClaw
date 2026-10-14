import { afterEach, describe, expect, it } from "vitest";
import { applyLoggingConfig, resetLogger } from "./logger.js";
import { redactSourceInputTextWithConfig } from "./redact-source.js";
import {
  captureSensitiveTextRedactionSnapshot,
  createSensitiveTextRedactor,
  prepareModelVisibleToolTextBlock,
  redactLogRecordForTransport,
  redactModelVisibleSecrets,
  redactModelVisibleToolPayloadText,
  redactSecrets,
  redactSensitiveText,
  redactToolPayloadTextWithConfig,
  serializeRedactedFileLogRecord,
} from "./redact.js";
import { withFullContextToolPayloadRedaction } from "./redact.test-support.js";
import { registerSecretValueForRedaction } from "./secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "./secret-redaction-registry.test-support.js";

afterEach(() => {
  resetSecretRedactionRegistryForTest();
  resetLogger();
});

describe("logging.redact mode", () => {
  const phone = "13900000000";
  const text = `手机号：${phone}\ntoken=fixture-only-credential-value`;

  it("preserves registered values across text, source, tool, and worker surfaces when off", () => {
    registerSecretValueForRedaction(phone);
    applyLoggingConfig({ redact: "off", redactPatterns: [phone] });

    expect(redactSensitiveText(text)).toBe(text);
    expect(redactToolPayloadTextWithConfig(text)).toBe(text);
    expect(
      redactToolPayloadTextWithConfig(text, withFullContextToolPayloadRedaction({ redact: "off" })),
    ).toBe(text);
    expect(redactModelVisibleToolPayloadText(text)).toBe(text);
    expect(redactSourceInputTextWithConfig(text)).toBe(text);
    const workerRedactor = createSensitiveTextRedactor(captureSensitiveTextRedactionSnapshot());
    expect(workerRedactor(text)).toBe(text);
  });

  it("preserves structured fields and serialized log values when off", () => {
    registerSecretValueForRedaction(phone);
    applyLoggingConfig({ redact: "off", redactPatterns: [phone] });
    const record = {
      message: text,
      password: phone,
      token: Number(phone),
      credential: true,
      nested: { authorization: `Bearer ${phone}` },
      publicShare: { id: phone },
    };

    expect(redactSecrets(record)).toEqual(record);
    expect(redactModelVisibleSecrets(record)).toEqual(record);
    expect(redactLogRecordForTransport(record, { format: "console" })).toEqual(record);
    expect(JSON.parse(serializeRedactedFileLogRecord(record))).toEqual(record);
    expect(
      JSON.parse(
        serializeRedactedFileLogRecord({ ...record, converted: { toJSON: () => record } }),
      ),
    ).toEqual({ ...record, converted: record });
  });

  it("re-prepares tool text and worker snapshots when redaction is toggled", () => {
    registerSecretValueForRedaction(phone);
    const block = { type: "text" as const, text: phone };
    applyLoggingConfig({ redact: "tools" });
    expect(prepareModelVisibleToolTextBlock(block).text).toBe("***");
    const enabledSnapshot = captureSensitiveTextRedactionSnapshot();

    applyLoggingConfig({ redact: "off" });
    const rawBlock = prepareModelVisibleToolTextBlock(block);
    expect(rawBlock.text).toBe(phone);
    const disabledSnapshot = captureSensitiveTextRedactionSnapshot();
    expect(createSensitiveTextRedactor(disabledSnapshot)(phone)).toBe(phone);

    applyLoggingConfig({ redact: "tools" });
    expect(prepareModelVisibleToolTextBlock(rawBlock).text).toBe("***");
    expect(createSensitiveTextRedactor(captureSensitiveTextRedactionSnapshot())(phone)).toBe("***");
    expect(createSensitiveTextRedactor(enabledSnapshot)(phone)).toBe("***");
    expect(createSensitiveTextRedactor(disabledSnapshot)(phone)).toBe(phone);
  });

  it.each([{}, { redact: "tools" as const }])("keeps redaction enabled for %j", (config) => {
    registerSecretValueForRedaction(phone);
    applyLoggingConfig(config);
    expect(redactSensitiveText(text)).not.toContain(phone);
    expect(redactModelVisibleSecrets({ password: phone, token: Number(phone) })).toEqual({
      password: "***",
      token: "***",
    });
  });
});
