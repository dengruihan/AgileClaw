import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
  navigateToControlUiSession,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI viewer presence acknowledgment",
  startServerBeforeBrowser: true,
});

async function lastDeclaration(gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  const declarations = await gateway.getRequests("sessions.viewers.set");
  return declarations.at(-1)?.params;
}

suite.define(() => {
  it("declares private focus, hidden state, and route session changes", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.viewers.set"],
        methodResponses: {
          "sessions.list": {
            ts: 1,
            path: "",
            count: 2,
            defaults: {},
            sessions: [
              { key: "agent:main:main", kind: "direct", label: "Main", updatedAt: 2 },
              { key: "agent:main:other", kind: "direct", label: "Other", updatedAt: 1 },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const first = await gateway.waitForRequest("sessions.viewers.set");
      expect(first.params).toMatchObject({
        sessionKeys: ["agent:main:main"],
        focused: expect.any(Boolean),
      });

      await page.evaluate(() => {
        Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
        window.dispatchEvent(new Event("blur"));
      });
      await expect
        .poll(() => lastDeclaration(gateway))
        .toMatchObject({ sessionKeys: ["agent:main:main"], focused: false });

      await page.evaluate(() => {
        Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
        window.dispatchEvent(new Event("focus"));
      });
      await expect
        .poll(() => lastDeclaration(gateway))
        .toMatchObject({ sessionKeys: ["agent:main:main"], focused: true });

      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect
        .poll(() => lastDeclaration(gateway))
        .toMatchObject({ sessionKeys: [], focused: false });

      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect
        .poll(() => lastDeclaration(gateway))
        .toMatchObject({ sessionKeys: ["agent:main:main"], focused: true });

      await navigateToControlUiSession(page, "agent:main:other");
      await expect
        .poll(() => lastDeclaration(gateway))
        .toMatchObject({ sessionKeys: ["agent:main:other"] });
    });
  });

  it("reports blur when another browser window takes focus", async () => {
    await suite.withPage({}, async ({ page, context }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.viewers.set"],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.bringToFront();
      await expect
        .poll(() => lastDeclaration(gateway))
        .toMatchObject({ sessionKeys: ["agent:main:main"], focused: true });

      const other = await context.newPage();
      const otherGateway = await installMockGateway(other, {
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.viewers.set"],
      });
      await other.goto(`${suite.server.baseUrl}chat`);
      await other.bringToFront();
      // Headless Chromium can keep both tabs document-focused; deliver the real
      // window blur the background tab receives so the declaration path is exercised.
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));

      await expect
        .poll(() => lastDeclaration(gateway))
        .toMatchObject({ sessionKeys: ["agent:main:main"], focused: false });
      expect(await otherGateway.getSocketCount()).toBe(1);
    });
  });

  it("retries a lost viewer acknowledgment while healthy ticks keep the socket open", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.viewers.set"],
        deferredMethods: ["sessions.viewers.set"],
      });
      await page.clock.install();
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const first = await gateway.waitForRequest("sessions.viewers.set");
      expect(first.params).toMatchObject({ sessionKeys: ["agent:main:main"] });
      await pauseVirtualClock(page);
      expect(await gateway.getSocketCount()).toBe(1);

      // The mock continues normal 30-second ticks while withholding only this
      // acknowledgment. Its operation deadline and existing retry delay both elapse.
      await page.clock.runFor(60_000);
      const declarations = await gateway.getRequests("sessions.viewers.set");
      expect(declarations).toHaveLength(2);
      expect(declarations[1]?.params).toEqual(first.params);
      expect(await gateway.getSocketCount()).toBe(1);
      expect(await gateway.getRequests("connect")).toHaveLength(1);

      await gateway.resolveDeferred("sessions.viewers.set", { sessionKeys: [] });
      await page.clock.runFor(60_000);
      expect(await gateway.getRequests("sessions.viewers.set")).toHaveLength(2);
      expect(await gateway.getSocketCount()).toBe(1);
    });
  });
});
