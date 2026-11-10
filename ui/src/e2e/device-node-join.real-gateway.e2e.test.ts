// Control UI E2E: the guided gateway-side node join against a real in-process
// Gateway. The browser mints a real single-use join URL, a real node-role
// client redeems it with the bootstrap token and receives the administrator
// auto-approved initial executor surface, while the browser's own operator
// identity pairs through the real pairing store. The same join URL is refused
// for a plaintext non-loopback Gateway, so the setup-code fallback is a real
// Gateway decision rather than a mocked error.
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { GatewayClient } from "../../../src/gateway/client.js";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../../src/infra/device-identity.js";
import { approveDevicePairing } from "../../../src/infra/device-pairing-approval.js";
import {
  listDevicePairing,
  requestDevicePairing,
  type PairedDevice,
} from "../../../src/infra/device-pairing.js";
import { NODE_EXECUTOR_PROFILE_COMMANDS } from "../../../src/infra/node-commands.js";
import { decodePairingSetupCode } from "../../../src/pairing/setup-code.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI guided node join with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir = "";

const NODE_DISPLAY_NAME = "Executor Node";
const PRIVATE_LAN_PUBLIC_URL = "ws://192.168.255.254";

type PairingPayload = { url: string; bootstrapToken: string; expiresAtMs: number };

async function capture(page: Page, fileName: string) {
  if (!captureEnabled) {
    return;
  }
  proofDir ||= createControlUiE2eArtifactDir("device-node-join-real-gateway");
  await page.screenshot({ animations: "disabled", path: path.join(proofDir, fileName) });
}

/** Confirm the gateway URL dialog. Required on first load; later reloads remember it. */
async function confirmGatewayUrl(page: Page, options: { required: boolean }) {
  const confirmation = page.locator("openclaw-gateway-url-confirmation");
  await confirmation
    .waitFor({ state: "visible", timeout: options.required ? 10_000 : 3_000 })
    .catch(() => undefined);
  if (!(await confirmation.isVisible().catch(() => false))) {
    if (options.required) {
      throw new Error("gateway URL confirmation dialog did not appear");
    }
    return;
  }
  await confirmation.getByRole("button", { name: /^Switch to /u }).click();
}

/** Pair the browser's own operator device through the same Gateway store the UI uses. */
async function installBrowserPairing(page: Page, port: number) {
  let seeded = false;
  await page.routeWebSocket(`ws://127.0.0.1:${port}/**`, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage(async (message) => {
      const frame = JSON.parse(String(message)) as {
        type?: string;
        method?: string;
        params?: {
          device?: { id?: string; publicKey?: string };
          role?: string;
          scopes?: string[];
          client?: { id?: string; mode?: string; platform?: string };
        };
      };
      if (
        !seeded &&
        frame.type === "req" &&
        frame.method === "connect" &&
        frame.params?.device?.id &&
        frame.params.device.publicKey
      ) {
        seeded = true;
        const request = await requestDevicePairing({
          deviceId: frame.params.device.id,
          publicKey: frame.params.device.publicKey,
          role: frame.params.role ?? "operator",
          scopes: frame.params.scopes ?? ["operator.admin"],
          clientId: frame.params.client?.id ?? "openclaw-control-ui",
          clientMode: frame.params.client?.mode ?? "webchat",
          platform: frame.params.client?.platform ?? "web",
          displayName: "Node join E2E browser",
        });
        await approveDevicePairing(request.request.requestId, {
          callerScopes: ["operator.admin"],
        });
      }
      server.send(message);
    });
    server.onMessage((message) => socket.send(message));
  });
}

async function openConnectMachine(page: Page) {
  // The real page settles its entrance animation after the Gateway handshake;
  // clicking the trigger directly keeps this focused on the pairing dialog.
  const trigger = page.locator("#new-session-where-trigger");
  await trigger.waitFor();
  await trigger.click({ force: true, timeout: 15_000 });
  const connect = page.getByRole("button", { name: "Connect a device" });
  await connect.waitFor();
  await connect.click();
  return page.locator('openclaw-modal-dialog[label="Connect a machine"]');
}

/** Reads the revealed secret row; the UI masks it until the operator asks to show it. */
async function revealSecret(dialog: ReturnType<Page["locator"]>) {
  await dialog.locator('.device-pair-setup__secret button[aria-pressed="false"]').click();
  const code = dialog.locator(".device-pair-setup__secret code");
  await expect.poll(async () => (await code.textContent()) ?? "").not.toContain("••••");
  return ((await code.textContent()) ?? "").trim();
}

function newPageOptions() {
  return {
    locale: "en-US",
    permissions: ["clipboard-read", "clipboard-write"],
    serviceWorkers: "block" as const,
    viewport: { height: 900, width: 1280 },
  };
}

async function seedOperatorIdentity(stateDir: string) {
  const identity = loadOrCreateDeviceIdentity({
    path: path.join(stateDir, "node-join-operator.sqlite"),
  });
  const request = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    role: "operator",
    scopes: ["operator.admin"],
    clientId: "node-join-real-gateway-e2e",
    clientMode: "cli",
    platform: process.platform,
    displayName: "Node join E2E operator",
  });
  await approveDevicePairing(request.request.requestId, {
    callerScopes: ["operator.admin"],
  });
  return identity;
}

type HelloMethods = { features: { methods: string[] } };

async function connectOperator(params: {
  port: number;
  token: string;
  stateDir: string;
}): Promise<GatewayClient> {
  const identity = await seedOperatorIdentity(params.stateDir);
  let resolveHello: () => void = () => {};
  let rejectHello: (error: Error) => void = () => {};
  const hello = new Promise<void>((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${params.port}`,
    token: params.token,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
    role: "operator",
    scopes: ["operator.admin"],
    deviceIdentity: identity,
    onHelloOk: () => resolveHello(),
    onConnectError: (error) => rejectHello(error),
    onClose: () => rejectHello(new Error("operator client closed before readiness")),
  });
  client.start();
  await Promise.race([
    hello,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("operator client did not connect")), 15_000),
    ),
  ]);
  return client;
}

type NodeListEntry = {
  nodeId: string;
  displayName?: string;
  connected?: boolean;
  paired?: boolean;
  approvalState?: string;
  commands?: string[];
};

async function readNode(operator: GatewayClient, nodeId: string) {
  const result = (await operator.request("node.list", {})) as { nodes?: NodeListEntry[] };
  return result.nodes?.find((node) => node.nodeId === nodeId);
}

function pairedNodeDevice(deviceId: string, paired: PairedDevice[]) {
  return paired.find((entry) => entry.deviceId === deviceId);
}

function startNodeClient(params: { port: number; payload: PairingPayload; stateDir: string }) {
  const identity = loadOrCreateDeviceIdentity({
    path: path.join(params.stateDir, "node-join-node.sqlite"),
  });
  let resolveHello: (hello: HelloMethods) => void = () => {};
  const hello = new Promise<HelloMethods>((resolve) => {
    resolveHello = resolve;
  });
  const client = new GatewayClient({
    url: params.payload.url,
    bootstrapToken: params.payload.bootstrapToken,
    preferBootstrapToken: true,
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: NODE_DISPLAY_NAME,
    mode: GATEWAY_CLIENT_MODES.NODE,
    role: "node",
    scopes: [],
    platform: "linux",
    caps: [],
    commands: [...NODE_EXECUTOR_PROFILE_COMMANDS],
    deviceIdentity: identity,
    onHelloOk: (value) => resolveHello(value),
  });
  client.start();
  return { client, hello, identity };
}

suite.define(() => {
  it("pairs a real node from the guided join URL and reports executor-ready inventory", async () => {
    const port = await getFreePort();
    const token = "node-join-real-gateway-token";
    const state = await createOpenClawTestState({
      label: "control-ui-device-node-join",
      layout: "home",
      env: {
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    let gateway: GatewayServer | undefined;
    let operator: GatewayClient | undefined;
    let nodeClient: GatewayClient | undefined;
    try {
      await state.writeConfig({
        gateway: {
          auth: { mode: "token", token },
          controlUi: { allowedOrigins: [new URL(suite.server.baseUrl).origin], enabled: false },
          port,
          nodes: {
            commands: { allow: [...NODE_EXECUTOR_PROFILE_COMMANDS] },
            pairing: { autoApproveLocal: false, sshVerify: false },
          },
        },
        plugins: {
          entries: {
            "device-pair": { config: { publicUrl: `ws://127.0.0.1:${port}` } },
          },
        },
      });
      state.applyEnv();
      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      gateway = await startGatewayServer(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      operator = await connectOperator({ port, token, stateDir: state.stateDir });

      await suite.withPage(newPageOptions(), async ({ page }) => {
        const gatewayUrl = `ws://127.0.0.1:${port}`;
        await installBrowserPairing(page, port);
        const url = new URL("new", suite.server.baseUrl);
        url.searchParams.set("gatewayUrl", gatewayUrl);
        url.hash = `token=${encodeURIComponent(token)}`;
        await page.goto(url.toString());
        await confirmGatewayUrl(page, { required: true });
        const dialog = await openConnectMachine(page);
        // The first setup request can pay the Gateway's cold bootstrap-token
        // writer startup; the dialog stays in its creating state until it resolves.
        await dialog
          .getByText(/This link is single-use and expires in/u)
          .waitFor({ timeout: 45_000 });

        // Download-to-pair guidance: both transfer steps render real app links.
        for (const platform of ["macOS", "Windows", "Linux"]) {
          await dialog
            .getByRole("link", { name: `${platform} download` })
            .first()
            .waitFor();
        }
        await dialog.getByRole("heading", { name: "Install the app on that machine" }).waitFor();
        await capture(page, "01-join-guidance.png");

        const joinUrl = await revealSecret(dialog);
        expect(joinUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/j/[A-Za-z0-9_-]+$`));
        await capture(page, "02-join-url-revealed.png");

        // The joining machine redeems the one-time URL over HTTP, exactly as the
        // node CLI does, then pairs over the Gateway WebSocket.
        const payloadResponse = await fetch(joinUrl);
        expect(payloadResponse.ok).toBe(true);
        const payload = (await payloadResponse.json()) as PairingPayload;
        expect(payload.url).toBe(gatewayUrl);
        expect(payload.bootstrapToken.length).toBeGreaterThan(0);

        const node = startNodeClient({ port, payload, stateDir: state.stateDir });
        nodeClient = node.client;
        // Administrator-minted node bootstrap auto-approves the initial
        // executor surface; later command expansions still need approval.
        const hello = await Promise.race([
          node.hello,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("node bootstrap did not connect")), 25_000),
          ),
        ]);
        expect(hello.features.methods).toContain("node.invoke");

        // The Gateway broadcast settles the dialog with the paired device name.
        await dialog.getByText(NODE_DISPLAY_NAME, { exact: true }).waitFor({ timeout: 20_000 });
        await dialog.getByText("Device paired · Node access", { exact: true }).waitFor();
        // The redeemed secret is retired from the DOM.
        expect(await dialog.locator(".device-pair-setup__secret").count()).toBe(0);
        expect((await dialog.textContent()) ?? "").not.toContain(joinUrl);
        await capture(page, "03-device-paired.png");

        // The approved node advertises the restricted executor surface.
        await expect
          .poll(async () => readNode(operator!, node.identity.deviceId), { timeout: 20_000 })
          .toMatchObject({
            connected: true,
            paired: true,
            approvalState: "approved",
            displayName: NODE_DISPLAY_NAME,
          });
        const inventoryNode = await readNode(operator, node.identity.deviceId);
        expect(inventoryNode?.commands).toEqual(
          expect.arrayContaining([
            "system.run",
            "system.run.prepare",
            "occupancy.acquire.v1",
            "occupancy.release.v1",
          ]),
        );

        // Open the inventory from the success state; the UI keeps the same device.
        await dialog.getByRole("button", { name: "Open device inventory" }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/devices");
        await page.getByText(NODE_DISPLAY_NAME, { exact: true }).first().waitFor();
        await capture(page, "04-device-inventory.png");

        // Canonical reconnect: restart the Gateway on the same port/state. The
        // node reconnects with its durable device token, never the spent
        // bootstrap bearer, and the UI still finds the paired executor.
        await gateway?.close({ reason: "node join e2e restart" });
        gateway = await startGatewayServer(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        await expect
          .poll(async () => readNode(operator!, node.identity.deviceId), { timeout: 25_000 })
          .toMatchObject({ connected: true, displayName: NODE_DISPLAY_NAME });
        await page.reload();
        await confirmGatewayUrl(page, { required: false });
        await page.getByText(NODE_DISPLAY_NAME, { exact: true }).first().waitFor();
        await capture(page, "05-device-after-gateway-restart.png");

        // The pairing store keeps one approved node device across the restart.
        const stored = await listDevicePairing();
        expect(pairedNodeDevice(node.identity.deviceId, stored.paired)?.role).toBe("node");
      });
    } finally {
      await nodeClient?.stopAndWait().catch(() => undefined);
      await operator?.stopAndWait().catch(() => undefined);
      await gateway?.close({ reason: "node join e2e cleanup" }).catch(() => undefined);
      await state.cleanup();
    }
  });

  it("redeems the displayed setup code with a real node client", async () => {
    const port = await getFreePort();
    const token = "node-join-real-gateway-setup-code-token";
    const state = await createOpenClawTestState({
      label: "control-ui-device-node-join-setup-code",
      layout: "home",
      env: {
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    let gateway: GatewayServer | undefined;
    let operator: GatewayClient | undefined;
    let nodeClient: GatewayClient | undefined;
    try {
      await state.writeConfig({
        gateway: {
          auth: { mode: "token", token },
          controlUi: { allowedOrigins: [new URL(suite.server.baseUrl).origin], enabled: false },
          port,
          nodes: {
            commands: { allow: [...NODE_EXECUTOR_PROFILE_COMMANDS] },
            pairing: { autoApproveLocal: false, sshVerify: false },
          },
        },
        plugins: {
          entries: {
            "device-pair": { config: { publicUrl: `ws://127.0.0.1:${port}` } },
          },
        },
      });
      state.applyEnv();
      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      gateway = await startGatewayServer(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      operator = await connectOperator({ port, token, stateDir: state.stateDir });

      await suite.withPage(newPageOptions(), async ({ page }) => {
        await installBrowserPairing(page, port);
        const url = new URL("new", suite.server.baseUrl);
        url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
        url.hash = `token=${encodeURIComponent(token)}`;
        await page.goto(url.toString());
        await confirmGatewayUrl(page, { required: true });
        const dialog = await openConnectMachine(page);
        await dialog
          .getByText(/This link is single-use and expires in/u)
          .waitFor({ timeout: 45_000 });

        const displayed = (
          (await dialog.locator(".device-pair-setup__fallback code").textContent()) ?? ""
        ).trim();
        expect(displayed.length).toBeGreaterThan(0);
        const setupCode = displayed.startsWith("oc-pair://") ? displayed : `oc-pair://${displayed}`;
        const payload = decodePairingSetupCode(setupCode) as PairingPayload;
        expect(payload.url).toBe(`ws://127.0.0.1:${port}`);
        expect(payload.bootstrapToken.length).toBeGreaterThan(0);

        const node = startNodeClient({ port, payload, stateDir: state.stateDir });
        nodeClient = node.client;
        const hello = await Promise.race([
          node.hello,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("setup-code bootstrap did not connect")), 25_000),
          ),
        ]);
        expect(hello.features.methods).toContain("node.invoke");
        await dialog.getByText(NODE_DISPLAY_NAME, { exact: true }).waitFor({ timeout: 20_000 });
        await expect
          .poll(async () => readNode(operator!, node.identity.deviceId), { timeout: 20_000 })
          .toMatchObject({
            connected: true,
            paired: true,
            approvalState: "approved",
            displayName: NODE_DISPLAY_NAME,
          });
        const inventory = await readNode(operator, node.identity.deviceId);
        expect(inventory?.commands).toEqual(
          expect.arrayContaining(["system.run", "occupancy.acquire.v1"]),
        );
      });
    } finally {
      await nodeClient?.stopAndWait().catch(() => undefined);
      await operator?.stopAndWait().catch(() => undefined);
      await gateway?.close({ reason: "node join setup-code e2e cleanup" }).catch(() => undefined);
      await state.cleanup();
    }
  });

  it("falls back to the bare setup code when the Gateway refuses a plaintext join URL", async () => {
    const port = await getFreePort();
    const token = "node-join-real-gateway-plaintext-token";
    const state = await createOpenClawTestState({
      label: "control-ui-device-node-join-plaintext",
      layout: "home",
      env: {
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    let gateway: GatewayServer | undefined;
    try {
      await state.writeConfig({
        gateway: {
          auth: { mode: "token", token },
          controlUi: { allowedOrigins: [new URL(suite.server.baseUrl).origin], enabled: false },
          port,
        },
        plugins: {
          entries: {
            "device-pair": { config: { publicUrl: `${PRIVATE_LAN_PUBLIC_URL}:${port}` } },
          },
        },
      });
      state.applyEnv();
      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      gateway = await startGatewayServer(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });

      await suite.withPage(newPageOptions(), async ({ page }) => {
        await installBrowserPairing(page, port);
        const url = new URL("new", suite.server.baseUrl);
        url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
        url.hash = `token=${encodeURIComponent(token)}`;
        await page.goto(url.toString());
        await confirmGatewayUrl(page, { required: true });
        const dialog = await openConnectMachine(page);

        // The Gateway refuses the plaintext non-loopback join URL; the dialog
        // shows the fallback guidance instead of a dead end.
        await dialog
          .getByText("Share the setup code instead", { exact: true })
          .waitFor({ timeout: 45_000 });
        await dialog
          .getByText(/This Gateway address is not encrypted, so one-time links are unavailable\./u)
          .waitFor();
        await dialog.getByText(/This setup code expires in/u).waitFor();
        await capture(page, "06-plaintext-fallback.png");

        const setupCode = await revealSecret(dialog);
        // The dialog renders the bare setup code without the oc-pair:// scheme.
        expect(setupCode).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
        // The fallback only offers a code, never a join link.
        expect(await dialog.locator(".device-pair-setup__fallback").count()).toBe(0);
        await capture(page, "07-plaintext-code-revealed.png");
      });
    } finally {
      await gateway?.close({ reason: "node join plaintext e2e cleanup" }).catch(() => undefined);
      await state.cleanup();
    }
  });
});
