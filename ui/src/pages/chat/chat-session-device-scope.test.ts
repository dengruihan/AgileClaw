/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  resolveChatSessionDeviceScope,
  sessionScopeDeviceLabelResolver,
} from "./chat-session-device-scope.ts";

const row = (overrides: Partial<GatewaySessionRow>): GatewaySessionRow => ({
  key: "agent:main:device-scoped",
  kind: "direct",
  updatedAt: 1,
  ...overrides,
});

function sessionsResult(rows: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "/tmp/sessions.json",
    count: rows.length,
    defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: 200_000 },
    sessions: rows,
  };
}

describe("chat session device scope", () => {
  it("reads the device name with the id and lease facts", () => {
    expect(
      resolveChatSessionDeviceScope({
        sessionKey: "agent:main:device-scoped",
        sessionsResult: sessionsResult([
          row({ scopeDeviceId: "studio-mac", scopeDeviceName: "Studio Mac", scopeLeaseHeld: true }),
        ]),
      }),
    ).toEqual({ deviceId: "studio-mac", deviceName: "Studio Mac", leaseHeld: true });
  });

  it("names only the scope device and falls back on whitespace-only names", () => {
    const resolve = sessionScopeDeviceLabelResolver(
      row({ scopeDeviceId: "studio-mac", scopeDeviceName: "  Studio Mac  " }),
    );
    expect(resolve("studio-mac")).toBe("Studio Mac");
    expect(resolve("other-pc")).toBeUndefined();

    expect(
      sessionScopeDeviceLabelResolver(row({ scopeDeviceId: "studio-mac", scopeDeviceName: "   " }))(
        "studio-mac",
      ),
    ).toBeUndefined();
    expect(sessionScopeDeviceLabelResolver(undefined)("studio-mac")).toBeUndefined();
  });
});
