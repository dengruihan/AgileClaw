/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import {
  appendPage,
  createAuthStatus,
  createHarness,
  drainPageUpdates,
  requestCount,
  waitForProviders,
  type ModelProvidersPageTestElement,
} from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("loads and refreshes model settings without account or usage requests", async () => {
  const harness = createHarness("main");
  const original = harness.request.getMockImplementation()!;
  harness.request.mockImplementation(async (method) =>
    method === "models.authStatus"
      ? createAuthStatus([
          { profiles: [{ profileId: "openai:account", type: "oauth", status: "ok" }] },
        ])
      : original(method),
  );
  const page = appendPage(harness.context);
  await waitForProviders(page);
  await page.refresh("forced");
  window.dispatchEvent(new Event("focus"));
  await drainPageUpdates(page);

  expect(page.querySelector('[data-provider-select="openai"]')).not.toBeNull();
  expect(page.querySelector(".model-providers__card-details")).toBeNull();
  expect(page.textContent).not.toContain("Accounts & usage");
  expect(requestCount(harness.request, "models.authStatus")).toBe(2);
  for (const method of ["usage.status", "sessions.usage", "codex.accountUsage"]) {
    expect(requestCount(harness.request, method)).toBe(0);
  }
});

it("waits for the route loader before model requests, including after reconnect", async () => {
  const harness = createHarness("main");
  const page = document.createElement(
    "openclaw-model-providers-page",
  ) as ModelProvidersPageTestElement;
  page.context = harness.context;
  document.body.append(page);
  await page.updateComplete;
  expect(harness.request.mock.calls.filter(([method]) => method !== "config.get")).toEqual([]);

  harness.publishPhase("offline");
  harness.publishPhase("connected");
  await page.updateComplete;
  expect(harness.request.mock.calls.filter(([method]) => method !== "config.get")).toEqual([]);

  page.routeData = {
    gateway: harness.context.gateway,
    gatewaySnapshot: harness.context.gateway.snapshot,
    selectionIntentRevision: harness.context.settingsAgentSelection.intentRevision,
    client: harness.context.gateway.snapshot.client,
    agentId: "main",
    data: { ...EMPTY_MODEL_PROVIDERS_DATA, updatedAt: Date.now() },
  };
  await drainPageUpdates(page);
  expect(page.data?.updatedAt).toEqual(expect.any(Number));
  expect(requestCount(harness.request, "models.authStatus")).toBe(0);
});
