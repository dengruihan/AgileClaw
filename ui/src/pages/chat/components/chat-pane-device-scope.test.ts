/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { renderChatPaneDeviceScope } from "./chat-pane-device-scope.ts";

afterEach(() => {
  document.body.replaceChildren();
});

function session(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key: "agent:main:device-scoped", kind: "direct", updatedAt: 1, ...overrides };
}

function mount(row: GatewaySessionRow | undefined): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderChatPaneDeviceScope(row), container);
  return container;
}

describe("chat pane device scope", () => {
  it("renders nothing for a gateway-hosted session", () => {
    expect(mount(session()).querySelector(".chat-pane__device-scope")).toBeNull();
  });

  it("shows the current device and lease facts without a release action", () => {
    const container = mount(session({ scopeDeviceId: "studio-mac", scopeLeaseHeld: true }));
    const chip = container.querySelector(".chat-pane__device-scope-chip");
    expect(chip?.textContent?.trim()).toBe("On studio-mac");
    expect(chip?.getAttribute("aria-label")).toBe(
      "Execution device: studio-mac. Held (session idle)",
    );
    expect(container.querySelector(".chat-pane__device-scope-facts")?.textContent).toContain(
      "studio-mac",
    );
    expect(container.querySelector(".chat-pane__device-scope-note")?.textContent).toContain(
      "Use Stop in the composer to release it.",
    );
    expect(container.querySelector('[aria-label*="release" i]')).toBeNull();
    expect(container.querySelectorAll("wa-dropdown-item")).toHaveLength(0);
    expect(container.querySelector(".sr-only[role=status]")?.textContent).toBe(
      "Execution device: studio-mac. Held (session idle)",
    );
  });

  it("reports a released lease without claiming the device is free for others", () => {
    const container = mount(session({ scopeDeviceId: "studio-mac", scopeLeaseHeld: false }));
    expect(
      container.querySelector(".chat-pane__device-scope-chip")?.getAttribute("aria-label"),
    ).toBe("Execution device: studio-mac. Released");
    expect(container.querySelector(".chat-pane__device-scope-note")?.textContent).toContain(
      "Tools in this session run on this device.",
    );
  });
});
