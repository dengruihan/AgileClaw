/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { showInputDialog } from "../../components/input-dialog.ts";
import { t } from "../../i18n/index.ts";
import { createInitialDevicesState } from "../../lib/nodes/page-operations.ts";
import { DevicesDialogController, type DevicesDialogHost } from "./devices-dialogs.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
vi.mock("../../components/input-dialog.ts", () => ({ showInputDialog: vi.fn() }));

type InputDialogOptions = Parameters<typeof showInputDialog>[0];

function createHost(overrides: Partial<DevicesDialogHost> = {}): DevicesDialogHost {
  const state = createInitialDevicesState({
    client: {} as GatewayBrowserClient,
    connected: true,
  });
  return {
    canManagePairing: () => true,
    gatewayConnected: () => true,
    requestGeneration: () => 0,
    gatewayClient: () => null,
    gatewayUrl: () => "http://gateway.test",
    runPageTask: async (task) => task(state),
    setDevicesError: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(showInputDialog).mockReset();
  vi.mocked(showConfirmDialog).mockReset();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("DevicesDialogController editAlias", () => {
  it("renames a paired device through the input dialog", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "device.pair.rename") {
        return { deviceId: (params as { deviceId: string }).deviceId };
      }
      return { paired: [], pending: [] };
    });
    const state = createInitialDevicesState({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
    });
    let captured: InputDialogOptions | undefined;
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      captured = options;
      return null;
    });

    const controller = new DevicesDialogController(
      createHost({
        runPageTask: async (task) => task(state),
      }),
    );
    const pending = controller.editAlias({
      id: "device-1",
      name: "Office node",
      operatorLabel: "Old alias",
    });
    await vi.waitFor(() => expect(captured).toBeDefined());

    expect(captured?.title).toBe(t("devices.inventory.renameTitle", { name: "Office node" }));
    expect(captured?.label).toBe(t("devices.inventory.renamePrompt"));
    expect(captured?.defaultValue).toBe("Old alias");
    expect(captured?.requireValue).toBe(true);
    expect(captured?.requireChange).toBe(true);

    const submit = captured?.submit;
    if (!submit) {
      throw new Error("Expected alias dialog submit");
    }
    const outcome = await submit("New alias");
    expect(outcome).toBeNull();
    expect(request).toHaveBeenCalledWith("device.pair.rename", {
      deviceId: "device-1",
      label: "New alias",
    });
    expect(request).toHaveBeenCalledWith("device.pair.list", {});
    await pending;
  });

  it("aborts an open alias dialog when its slot is cancelled", async () => {
    let captured: InputDialogOptions | undefined;
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      captured = options;
      // Sit open the way a dialog waiting on the operator does.
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return null;
    });

    const controller = new DevicesDialogController(createHost());
    const pending = controller.editAlias({ id: "device-1", name: "Browser" });
    await vi.waitFor(() => expect(captured).toBeDefined());

    controller.cancel();
    await pending;

    expect(captured?.signal?.aborted).toBe(true);
  });

  it("refuses a rename submitted after pairing access was lost", async () => {
    const request = vi.fn().mockResolvedValue({});
    const state = createInitialDevicesState({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
    });
    let canManagePairing = true;
    let captured: InputDialogOptions | undefined;
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      captured = options;
      return null;
    });

    const controller = new DevicesDialogController(
      createHost({
        canManagePairing: () => canManagePairing,
        runPageTask: async (task) => task(state),
      }),
    );
    const pending = controller.editAlias({ id: "device-1", name: "Browser" });
    await vi.waitFor(() => expect(captured).toBeDefined());

    canManagePairing = false;

    const submit = captured?.submit;
    if (!submit) {
      throw new Error("Expected alias dialog submit");
    }
    const outcome = await submit("New name");
    expect(outcome).toContain("operator.pairing");
    expect(request).not.toHaveBeenCalled();
    await pending;
  });
});

describe("DevicesDialogController editDevicePolicy", () => {
  function policyHost(request: ReturnType<typeof vi.fn>) {
    const state = createInitialDevicesState({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
    });
    let captured: InputDialogOptions | undefined;
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      captured = options;
      return null;
    });
    const controller = new DevicesDialogController(
      createHost({ runPageTask: async (task) => task(state) }),
    );
    return { controller, state, captured: () => captured };
  }

  it("replaces the deny list while preserving an existing allow list", async () => {
    const request = vi.fn(async () => ({ paired: [], pending: [], sessions: [] }));
    const { controller, captured } = policyHost(request);
    const pending = controller.editDevicePolicy({
      id: "studio-mac",
      name: "Studio Mac",
      commandPolicy: { allow: ["system.info"], deny: ["system.run"] },
    });
    await vi.waitFor(() => expect(captured()).toBeDefined());
    expect(captured()?.defaultValue).toBe("system.run");
    expect(captured()?.title).toBe(t("devices.registry.editTitle", { name: "Studio Mac" }));

    const outcome = await captured()?.submit?.("system.run, system.info, system.run");
    expect(outcome).toBeNull();
    expect(request).toHaveBeenCalledWith("node.device.update", {
      nodeId: "studio-mac",
      commands: { allow: ["system.info"], deny: ["system.run", "system.info"] },
    });
    await pending;
  });

  it("clears the policy when the deny list is emptied and there is no allow list", async () => {
    const request = vi.fn(async () => ({ paired: [], pending: [], sessions: [] }));
    const { controller, captured } = policyHost(request);
    const pending = controller.editDevicePolicy({
      id: "studio-mac",
      name: "Studio Mac",
      commandPolicy: { deny: ["system.run"] },
    });
    await vi.waitFor(() => expect(captured()).toBeDefined());

    expect(await captured()?.submit?.("")).toBeNull();
    expect(request).toHaveBeenCalledWith("node.device.update", { nodeId: "studio-mac" });
    await pending;
  });

  it("keeps the dialog open with the Gateway's error when the update fails", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "node.device.update") {
        throw new Error("node.device.update failed");
      }
      return { paired: [], pending: [], sessions: [] };
    });
    const { controller, captured } = policyHost(request);
    const pending = controller.editDevicePolicy({
      id: "studio-mac",
      name: "Studio Mac",
      commandPolicy: null,
    });
    await vi.waitFor(() => expect(captured()).toBeDefined());

    expect(await captured()?.submit?.("system.run")).toContain("node.device.update failed");
    await pending;
  });
});

describe("DevicesDialogController confirmDeviceDisable", () => {
  function disableHost(request: ReturnType<typeof vi.fn>) {
    const state = createInitialDevicesState({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
    });
    return new DevicesDialogController(createHost({ runPageTask: async (task) => task(state) }));
  }

  it("states the destructive consequence and disables only after confirmation", async () => {
    const request = vi.fn(async () => ({ paired: [], pending: [], sessions: [] }));
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await disableHost(request).confirmDeviceDisable({ id: "studio-mac", name: "Studio Mac" });

    expect(showConfirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        danger: true,
        title: t("devices.registry.disableTitle", { name: "Studio Mac" }),
        message: t("devices.registry.disableBody"),
        confirmLabel: t("devices.registry.disableAction"),
      }),
    );
    expect(request).toHaveBeenCalledWith("node.device.disable", { nodeId: "studio-mac" });
  });

  it("performs no write when the confirmation is cancelled", async () => {
    const request = vi.fn(async () => ({ paired: [], pending: [], sessions: [] }));
    vi.mocked(showConfirmDialog).mockResolvedValue(false);

    await disableHost(request).confirmDeviceDisable({ id: "studio-mac", name: "Studio Mac" });

    expect(request).not.toHaveBeenCalled();
  });

  it("performs no write when pairing access is lost while the dialog is open", async () => {
    const request = vi.fn(async () => ({ paired: [], pending: [], sessions: [] }));
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const state = createInitialDevicesState({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
    });
    let canManagePairing = true;
    const controller = new DevicesDialogController(
      createHost({
        canManagePairing: () => canManagePairing,
        runPageTask: async (task) => task(state),
      }),
    );
    const pending = controller.confirmDeviceDisable({ id: "studio-mac", name: "Studio Mac" });
    canManagePairing = false;
    await pending;

    expect(request).not.toHaveBeenCalled();
  });
});
