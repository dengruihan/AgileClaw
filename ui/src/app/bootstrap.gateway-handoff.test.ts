import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import { bootstrapApplication } from "./bootstrap.ts";
import { loadGatewaySessionSelection, loadSettings, saveSettings } from "./settings.ts";

it.each([
  { name: "saved target agent", selectedAgentId: "research" },
  { name: "unsaved target agent", selectedAgentId: undefined },
])("hydrates the $name during native Gateway handoff", ({ selectedAgentId }) => {
  const previousSettings = loadSettings();
  const previousUrl = window.location.href;
  const targetGatewayUrl = `wss://native-${selectedAgentId ?? "unset"}.example`;
  const targetSettingsKey = `openclaw.control.settings.v1:${gatewayOriginScope(targetGatewayUrl)}`;
  let runtime: ReturnType<typeof bootstrapApplication> | undefined;

  try {
    saveSettings({
      ...previousSettings,
      gatewayUrl: targetGatewayUrl,
      sessionKey: "global",
      lastActiveSessionKey: "global",
      selectedAgentId,
    });
    saveSettings({
      ...previousSettings,
      sessionKey: "agent:dummy:main",
      lastActiveSessionKey: "agent:dummy:main",
      selectedAgentId: "dummy",
    });
    window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
      gatewayUrl: targetGatewayUrl,
      token: "native-token",
    };
    window.history.replaceState({}, "", "/settings/appearance");

    runtime = bootstrapApplication();

    expect(runtime.context.gateway.connection.gatewayUrl).toBe(targetGatewayUrl);
    expect(runtime.context.gateway.snapshot.sessionKey).toBe("global");
    expect(loadGatewaySessionSelection(targetGatewayUrl)).toEqual({
      sessionKey: "global",
      lastActiveSessionKey: "global",
      ...(selectedAgentId ? { selectedAgentId } : {}),
    });
  } finally {
    runtime?.stop();
    delete window["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
    localStorage.removeItem(targetSettingsKey);
    window.history.replaceState({}, "", previousUrl);
    saveSettings(previousSettings);
  }
});
