/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevicesViewProps } from "../../test-helpers/devices-fixtures.ts";
import { getDevicesSection } from "../../test-helpers/devices-view.ts";
import { renderDevices } from "./view.ts";
import type { DevicesProps } from "./view.types.ts";

afterEach(() => {
  document.body.replaceChildren();
});

const pairedNodes = [
  {
    nodeId: "studio-mac",
    displayName: "Studio Mac",
    platform: "darwin",
    paired: true,
    connected: true,
    enabled: true,
    commands: ["system.run"],
    commandPolicy: { deny: ["system.run"] },
  },
  {
    nodeId: "office-pc",
    displayName: "Office PC",
    platform: "win32",
    paired: true,
    connected: false,
    enabled: false,
    commands: ["system.run"],
  },
  {
    nodeId: "unpaired-phone",
    displayName: "Phone without node pairing",
    paired: false,
  },
];

function mount(overrides: Partial<DevicesProps> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderDevices(createDevicesViewProps({ nodes: pairedNodes, ...overrides })), container);
  return container;
}

function deviceRow(container: Element, name: string): Element {
  const row = Array.from(container.querySelectorAll(".device-entry")).find(
    (candidate) =>
      candidate.querySelector(".settings-row__title")?.textContent?.trim() === name &&
      !candidate.closest("details"),
  );
  if (!(row instanceof Element)) {
    throw new Error(`Expected device row ${name}`);
  }
  return row;
}

describe("consolidated device rows", () => {
  it("renders one paired-devices section with one row per device", () => {
    const container = mount();
    const headings = Array.from(container.querySelectorAll(".settings-section")).map((section) =>
      section.querySelector(".settings-section__heading")?.textContent?.trim(),
    );
    expect(headings.filter((heading) => heading?.startsWith("Paired devices"))).toHaveLength(1);
    expect(headings.some((heading) => /execution devices/iu.test(heading ?? ""))).toBe(false);
    // Three catalog rows render once each; only the two paired nodes carry
    // execution controls.
    expect(container.querySelectorAll(".device-entry")).toHaveLength(3);
    expect(container.querySelectorAll(".device-registry__row")).toHaveLength(2);
    expect(
      container.querySelector('.device-entry[data-device-id="unpaired-phone"] wa-switch'),
    ).toBeNull();
  });

  it("pairs connection, enabled, policy, and occupancy status on one row", () => {
    const container = mount({
      deviceOccupancy: [
        {
          deviceId: "studio-mac",
          sessionKey: "agent:main:studio",
          sessionLabel: "Studio session",
          agentId: "main",
        },
      ],
    });
    const studio = deviceRow(container, "Studio Mac");
    expect(studio.textContent).toContain("connected");
    expect(studio.textContent).toContain("Enabled");
    expect(studio.textContent).toContain("1 denied");
    expect(studio.textContent).toContain("In use by Studio session");
    expect(
      studio.querySelector<HTMLElement>(".device-registry__holder")?.getAttribute("aria-label"),
    ).toBe("Open session Studio session");

    const office = deviceRow(container, "Office PC");
    expect(office.textContent).toContain("offline");
    expect(office.textContent).toContain("Disabled");
    expect(office.textContent).toContain("Idle");
    expect(office.querySelector(".device-registry__holder")).toBeNull();
  });

  it("opens the holding session when the occupancy drill-in is activated", () => {
    const onDeviceRegistryHolderOpen = vi.fn();
    const holder = {
      deviceId: "studio-mac",
      sessionKey: "agent:main:studio",
      sessionLabel: "Studio session",
    };
    const container = mount({ deviceOccupancy: [holder], onDeviceRegistryHolderOpen });
    deviceRow(container, "Studio Mac")
      .querySelector<HTMLButtonElement>(".device-registry__holder")
      ?.click();
    expect(onDeviceRegistryHolderOpen).toHaveBeenCalledWith(holder);
  });

  it("enables and disables execution through the row switch", () => {
    const onDeviceRegistryEnabled = vi.fn();
    const container = mount({ onDeviceRegistryEnabled });
    const officeSwitch = deviceRow(container, "Office PC").querySelector<
      HTMLElement & { checked: boolean }
    >("wa-switch.settings-toggle");
    expect(officeSwitch?.checked).toBe(false);
    if (!officeSwitch) {
      throw new Error("Expected enable switch");
    }
    officeSwitch.checked = true;
    officeSwitch.dispatchEvent(new Event("change"));
    expect(onDeviceRegistryEnabled).toHaveBeenCalledWith(
      { id: "office-pc", name: "Office PC" },
      true,
    );

    const studioSwitch = deviceRow(container, "Studio Mac").querySelector<
      HTMLElement & { checked: boolean }
    >("wa-switch.settings-toggle");
    if (!studioSwitch) {
      throw new Error("Expected enable switch");
    }
    studioSwitch.checked = false;
    studioSwitch.dispatchEvent(new Event("change"));
    expect(onDeviceRegistryEnabled).toHaveBeenLastCalledWith(
      { id: "studio-mac", name: "Studio Mac" },
      false,
    );
  });

  it("opens the command-policy editor with the row's current policy", () => {
    const onDeviceRegistryEdit = vi.fn();
    const container = mount({ onDeviceRegistryEdit });
    deviceRow(container, "Studio Mac")
      .querySelector<HTMLButtonElement>('button[aria-label="Edit policy for Studio Mac"]')
      ?.click();
    expect(onDeviceRegistryEdit).toHaveBeenCalledWith({
      id: "studio-mac",
      name: "Studio Mac",
      commandPolicy: { deny: ["system.run"] },
    });
  });

  it("never offers a device-level release control", () => {
    const container = mount({
      deviceOccupancy: [
        { deviceId: "studio-mac", sessionKey: "agent:main:studio", sessionLabel: "Studio session" },
      ],
    });
    const section = getDevicesSection(container, "Paired devices");
    const labels = Array.from(section.querySelectorAll("button")).map((button) =>
      button.textContent?.trim(),
    );
    expect(labels.some((label) => /release/iu.test(label ?? ""))).toBe(false);
    expect(section.textContent).toContain("use Stop in its composer");
  });

  it("keeps execution writes disabled without pairing access", () => {
    const onDeviceRegistryEnabled = vi.fn();
    const container = mount({ canManagePairing: false, onDeviceRegistryEnabled });
    const toggle = deviceRow(container, "Studio Mac").querySelector<
      HTMLElement & { checked: boolean; hasAttribute: (name: string) => boolean }
    >("wa-switch.settings-toggle");
    expect(toggle?.hasAttribute("disabled")).toBe(true);
    expect(
      deviceRow(container, "Studio Mac").querySelector<HTMLButtonElement>(
        'button[aria-label="Edit policy for Studio Mac"]',
      )?.disabled,
    ).toBe(true);
  });
});
