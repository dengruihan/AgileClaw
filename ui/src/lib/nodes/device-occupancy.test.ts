// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  loadDeviceOccupancy,
  parseDeviceOccupancy,
  type DeviceOccupancyState,
} from "./device-occupancy.ts";

function createState(
  request: (method: string, params?: unknown) => Promise<unknown>,
  overrides: Partial<DeviceOccupancyState> = {},
): DeviceOccupancyState {
  return {
    client: { request },
    connected: true,
    requestGeneration: 0,
    occupancyLoading: false,
    deviceOccupancy: null,
    occupancyError: null,
    ...overrides,
  };
}

describe("parseDeviceOccupancy", () => {
  it("keeps only rows that report a held lease with a device and session key", () => {
    const entries = parseDeviceOccupancy([
      { key: "agent:main:held", scopeDeviceId: "studio-mac", scopeLeaseHeld: true },
      { key: "agent:main:idle", scopeDeviceId: "studio-mac", scopeLeaseHeld: false },
      { key: "agent:main:missing-lease", scopeDeviceId: "studio-mac" },
      { key: "agent:main:no-device", scopeLeaseHeld: true },
      { scopeDeviceId: "studio-mac", scopeLeaseHeld: true },
      { key: "agent:main:no-key-lease", scopeDeviceId: "studio-mac", scopeLeaseHeld: "true" },
      null,
      "row",
    ]);

    expect(entries).toEqual([
      {
        deviceId: "studio-mac",
        sessionKey: "agent:main:held",
        sessionLabel: "agent:main:held",
      },
    ]);
  });

  it("falls back from label to display name to the session key and trims fields", () => {
    expect(
      parseDeviceOccupancy([
        {
          key: " agent:main:labeled ",
          scopeDeviceId: " studio-mac ",
          scopeLeaseHeld: true,
          label: " Studio session ",
          agentId: " main ",
        },
        {
          key: "agent:main:display",
          scopeDeviceId: "office-pc",
          scopeLeaseHeld: true,
          displayName: "  Office session ",
        },
        {
          key: "agent:main:plain",
          scopeDeviceId: "gateway-host",
          scopeLeaseHeld: true,
        },
      ]),
    ).toEqual([
      {
        deviceId: "studio-mac",
        sessionKey: "agent:main:labeled",
        sessionLabel: "Studio session",
        agentId: "main",
      },
      {
        deviceId: "office-pc",
        sessionKey: "agent:main:display",
        sessionLabel: "Office session",
      },
      {
        deviceId: "gateway-host",
        sessionKey: "agent:main:plain",
        sessionLabel: "agent:main:plain",
      },
    ]);
  });

  it("treats malformed payloads as no occupancy", () => {
    expect(parseDeviceOccupancy(undefined)).toEqual([]);
    expect(parseDeviceOccupancy({ sessions: [] })).toEqual([]);
  });
});

describe("loadDeviceOccupancy", () => {
  it("reads bounded sessions and stores the projected holders", async () => {
    const request = vi.fn(async () => ({
      sessions: [
        {
          key: "agent:main:studio",
          scopeDeviceId: "studio-mac",
          scopeLeaseHeld: true,
          label: "Studio session",
        },
      ],
    }));
    const state = createState(request);

    await loadDeviceOccupancy(state);

    expect(request).toHaveBeenCalledWith("sessions.list", {
      limit: 500,
      excludeSubagents: true,
      includeGlobal: true,
    });
    expect(state.deviceOccupancy).toEqual([
      {
        deviceId: "studio-mac",
        sessionKey: "agent:main:studio",
        sessionLabel: "Studio session",
      },
    ]);
    expect(state.occupancyLoading).toBe(false);
    expect(state.occupancyError).toBeNull();
  });

  it("discards a response whose connection generation moved on", async () => {
    const response = createDeferred<{ sessions: unknown[] }>();
    const request = vi.fn(() => response.promise);
    const state = createState(request);
    const load = loadDeviceOccupancy(state);
    state.requestGeneration += 1;

    response.resolve({
      sessions: [
        {
          key: "agent:main:studio",
          scopeDeviceId: "studio-mac",
          scopeLeaseHeld: true,
        },
      ],
    });
    await load;

    expect(state.deviceOccupancy).toBeNull();
  });

  it("reports read failures only for foreground reads", async () => {
    const request = vi.fn(async () => {
      throw new Error("sessions.list denied");
    });
    const foreground = createState(request);
    await loadDeviceOccupancy(foreground);
    expect(foreground.occupancyError).toContain("sessions.list denied");

    const quiet = createState(request, { occupancyError: "Earlier failure" });
    await loadDeviceOccupancy(quiet, { quiet: true });
    expect(quiet.occupancyError).toBe("Earlier failure");
  });

  it("skips disconnected and in-flight reads", async () => {
    const request = vi.fn(async () => ({ sessions: [] }));
    await loadDeviceOccupancy(createState(request, { connected: false }));
    await loadDeviceOccupancy(createState(request, { occupancyLoading: true }));
    expect(request).not.toHaveBeenCalled();
  });
});
