/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderDevicePairSetup } from "./view-pairing.runtime.ts";

function pairingProps(
  overrides: Partial<Parameters<typeof renderDevicePairSetup>[0]> = {},
): Parameters<typeof renderDevicePairSetup>[0] {
  return {
    open: true,
    lifecycle: { phase: "selection", access: "full" },
    nowMs: 0,
    pendingCount: 0,
    nodeOnly: false,
    secretRevealed: false,
    onToggleSecret: vi.fn(),
    onRefresh: vi.fn(),
    onAccessChange: vi.fn(),
    onClose: vi.fn(),
    onManageDevices: vi.fn(),
    onOpenConnectionSettings: vi.fn(),
    onGetApps: vi.fn(),
    ...overrides,
  };
}

function renderDialog(props: Parameters<typeof renderDevicePairSetup>[0]) {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderDevicePairSetup(props), container);
  return container;
}

describe("device pairing dialog", () => {
  it.each([
    {
      access: "full" as const,
      href: "https://docs.openclaw.ai/channels/pairing#pair-from-the-control-ui-recommended",
    },
    {
      access: "node" as const,
      href: "https://docs.openclaw.ai/gateway/pairing#one-paste-node-pairing",
    },
  ])("links $access setup help to the matching workflow", ({ access, href }) => {
    const container = renderDialog(pairingProps({ lifecycle: { phase: "selection", access } }));

    expect(container.textContent).toContain(
      "Device capabilities plus complete Gateway controls, including settings and upgrades.",
    );
    expect(container.textContent).toContain("Connect a computer as a command and capability host.");
    expect(container.querySelector<HTMLAnchorElement>(".device-pair-setup__footer a")?.href).toBe(
      href,
    );
    container.remove();
  });

  it("renders the node handoff as guided steps without any terminal command", () => {
    const joinUrl = "https://gateway.example.com/j/fresh-code";
    const container = renderDialog(
      pairingProps({
        lifecycle: {
          phase: "waiting",
          access: "node",
          setup: {
            setupId: "setup-node",
            setupCode: "AbC_123",
            joinUrl,
            gatewayUrl: "wss://gateway.example",
            auth: "token",
            urlSource: "test",
            access: "node",
            expiresAtMs: 70_000,
          },
        },
        nowMs: 10_000,
      }),
    );

    const rendered = container.textContent ?? "";
    expect(container.querySelectorAll(".device-pair-setup__step")).toHaveLength(3);
    expect(rendered).not.toContain("openclaw node run");
    expect(rendered).not.toContain("npx openclaw");
    expect(rendered).not.toContain(joinUrl);
    // Masked by default; the reveal toggle owns the only path to the plaintext URL.
    expect(container.querySelector(".device-pair-setup__secret code")?.textContent).not.toContain(
      joinUrl,
    );
    expect(container.querySelector('[aria-pressed="false"].btn')?.textContent?.trim()).toBe("Show");
    expect(container.querySelector('[role="timer"]')?.textContent?.trim()).toBe(
      "This link is single-use and expires in 1:00.",
    );
    const fallback = container.querySelector<HTMLDetailsElement>(".device-pair-setup__fallback");
    expect(fallback?.querySelector("code")?.textContent).toBe("AbC_123");
    const downloadLinks = [
      ...container.querySelectorAll<HTMLAnchorElement>(".device-pair-setup__downloads a"),
    ];
    expect(downloadLinks.map((link) => link.textContent?.trim())).toEqual([
      "macOS",
      "Windows",
      "Linux",
    ]);
    expect(downloadLinks.every((link) => link.target === "_blank")).toBe(true);
    container.remove();
  });

  it("reveals the join URL only when the host marks the secret revealed", () => {
    const joinUrl = "https://gateway.example.com/j/revealed";
    const container = renderDialog(
      pairingProps({
        lifecycle: {
          phase: "waiting",
          access: "node",
          setup: {
            setupId: "setup-node",
            setupCode: "AbC_123",
            joinUrl,
            gatewayUrl: "wss://gateway.example",
            auth: "token",
            urlSource: "test",
            access: "node",
            expiresAtMs: 70_000,
          },
        },
        nowMs: 10_000,
        secretRevealed: true,
      }),
    );

    expect(container.querySelector(".device-pair-setup__secret code")?.textContent?.trim()).toBe(
      joinUrl,
    );
    expect(container.querySelector('[aria-pressed="true"].btn')?.textContent?.trim()).toBe("Hide");
    container.remove();
  });

  it("presents the bare setup code as the transfer secret for plaintext LAN setups", () => {
    const container = renderDialog(
      pairingProps({
        lifecycle: {
          phase: "waiting",
          access: "node",
          setup: {
            setupId: "setup-plain",
            setupCode: "PLAIN_CODE",
            gatewayUrl: "ws://gateway.example",
            auth: "token",
            urlSource: "test",
            access: "node",
            expiresAtMs: 70_000,
          },
        },
        nowMs: 10_000,
      }),
    );

    const rendered = container.textContent ?? "";
    expect(rendered).toContain("Share the setup code instead");
    expect(rendered).toContain(
      "This Gateway address is not encrypted, so one-time links are unavailable.",
    );
    expect(container.querySelector(".device-pair-setup__secret code")?.textContent).not.toContain(
      "PLAIN_CODE",
    );
    expect(container.querySelector(".device-pair-setup__fallback")).toBeNull();
    container.remove();
  });

  it("links a failed setup request to the existing connection settings", () => {
    const onOpenConnectionSettings = vi.fn();
    const container = renderDialog(
      pairingProps({
        lifecycle: {
          phase: "error",
          source: "create",
          access: "node",
          message: "setup unavailable",
        },
        onOpenConnectionSettings,
      }),
    );

    const settingsButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Connection settings",
    );
    expect(settingsButton).toBeDefined();
    settingsButton?.click();
    expect(onOpenConnectionSettings).toHaveBeenCalledOnce();
    container.remove();
  });

  it("offers the device inventory from the paired state", () => {
    const onManageDevices = vi.fn();
    const container = renderDialog(
      pairingProps({
        lifecycle: { phase: "success", access: "node", deviceName: "Lab Mac" },
        onManageDevices,
      }),
    );

    const inventoryButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Open device inventory",
    );
    expect(inventoryButton).toBeDefined();
    inventoryButton?.click();
    expect(onManageDevices).toHaveBeenCalledOnce();
    container.remove();
  });
});
