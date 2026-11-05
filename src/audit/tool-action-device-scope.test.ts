import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearToolActionDeviceScopesForTest,
  hashAuditDeviceRef,
  publishToolActionDeviceScope,
  resolveToolActionDeviceRef,
} from "./tool-action-device-scope.js";

afterEach(() => {
  clearToolActionDeviceScopesForTest();
});

describe("tool action device scope resolution", () => {
  it("seeds an unseen session once and reuses the cached scope", () => {
    const resolve = vi.fn(() => "device-a");
    const sessionKey = "agent:main:scoped";

    expect(resolveToolActionDeviceRef(sessionKey, resolve)).toBe(hashAuditDeviceRef("device-a"));
    expect(resolveToolActionDeviceRef(sessionKey, resolve)).toBe(hashAuditDeviceRef("device-a"));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(sessionKey);
  });

  it("caches a gateway scope so later events do not reread the session owner", () => {
    const resolve = vi.fn(() => null);
    const sessionKey = "agent:main:gateway";

    expect(resolveToolActionDeviceRef(sessionKey, resolve)).toBeUndefined();
    expect(resolveToolActionDeviceRef(sessionKey, resolve)).toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("retries an unresolved session on the next event instead of caching absence", () => {
    const resolve = vi.fn<(sessionKey: string) => string | null | undefined>();
    resolve.mockReturnValueOnce(undefined).mockReturnValue("device-a");
    const sessionKey = "agent:main:created";

    expect(resolveToolActionDeviceRef(sessionKey, resolve)).toBeUndefined();
    expect(resolveToolActionDeviceRef(sessionKey, resolve)).toBe(hashAuditDeviceRef("device-a"));
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("lets a committed gateway publish win over a stale resolver", () => {
    const resolve = vi.fn(() => "device-a");
    const sessionKey = "agent:main:root";

    publishToolActionDeviceScope({ sessionKey, deviceId: "device-a" });
    publishToolActionDeviceScope({ sessionKey, deviceId: null });

    expect(resolveToolActionDeviceRef(sessionKey, resolve)).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps the resolver optional for cache-only readers", () => {
    expect(resolveToolActionDeviceRef("agent:main:unknown")).toBeUndefined();
    expect(resolveToolActionDeviceRef(undefined)).toBeUndefined();
  });
});
