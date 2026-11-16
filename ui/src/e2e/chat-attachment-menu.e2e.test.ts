import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  attachmentBrowserFixtures,
  installAttachmentBrowserIdentity,
} from "./chat-attachment-menu.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { ONE_PIXEL_PNG_B64 } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Unified attachment menu" });

const ATTACHMENT_TYPES = ["image/*", "video/*", "audio/*", "application/pdf", ".docx", ".zip"];

async function openAttachmentMenu(page: Page) {
  const trigger = page.getByRole("button", { name: "Add attachment", exact: true });
  await trigger.press("Enter");
  const item = page.locator('.agent-chat__attach-menu-option[value="file"]');
  await item.waitFor({ state: "visible" });
  return item;
}

async function chooseAttachment(page: Page) {
  const item = await openAttachmentMenu(page);
  const pending = page.waitForEvent("filechooser");
  await item.press("Enter");
  return pending;
}

async function expectSingleAttachmentMenu(page: Page) {
  const items = page.locator(".agent-chat__attach-menu-option:visible");
  await expect.poll(() => items.count()).toBe(1);
  expect((await items.allTextContents()).map((text) => text.trim())).toEqual(["Attachment"]);
  expect(await page.locator("openclaw-chat-camera-capture").count()).toBe(0);
  for (const retired of ["Take photo", "Photo", "File"]) {
    expect(await page.getByRole("menuitem", { name: retired, exact: true }).count()).toBe(0);
  }
}

suite.define(() => {
  for (const route of ["chat", "new"]) {
    it(`offers one Attachment option that appends files through the system chooser in ${route}`, async () => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        await installMockGateway(page, { historyMessages: [] });
        await page.goto(suite.server.baseUrl + route);
        const trigger = page.getByRole("button", { name: "Add attachment", exact: true });
        await trigger.click();
        await expectSingleAttachmentMenu(page);
        await page.keyboard.press("Escape");
        await page
          .locator('.agent-chat__attach-menu-option[value="file"]')
          .waitFor({ state: "hidden" });

        // The menu stays identical at phone width; width is not a picker capability.
        await page.setViewportSize({ width: 390, height: 844 });
        await trigger.press("Enter");
        await expectSingleAttachmentMenu(page);
        await page.keyboard.press("Escape");
        await page
          .locator('.agent-chat__attach-menu-option[value="file"]')
          .waitFor({ state: "hidden" });
        await page.setViewportSize({ width: 1280, height: 900 });

        const chooser = await chooseAttachment(page);
        const input = chooser.element();
        expect(await input.getAttribute("class")).toBe("agent-chat__file-input");
        expect(chooser.isMultiple()).toBe(true);
        expect(await input.getAttribute("capture")).toBeNull();
        const accept = await input.getAttribute("accept");
        for (const type of ATTACHMENT_TYPES) {
          expect(accept).toContain(type);
        }
        // Boundary-only cancellation: Playwright does not exercise OS dialogs.
        await chooser.setFiles([]);
        expect(await page.locator(".chat-attachment-thumb").count()).toBe(0);

        const note = {
          name: "note.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Synthetic attachment"),
        };
        const pixel = {
          name: "pixel.png",
          mimeType: "image/png",
          buffer: Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
        };
        await (await chooseAttachment(page)).setFiles([pixel, note]);
        const ready = page.locator('.chat-attachment-thumb[aria-busy="false"]');
        await expect.poll(() => ready.count()).toBe(2);
        await page.getByRole("button", { name: "Remove note.txt", exact: true }).click();
        await expect.poll(() => ready.count()).toBe(1);
        await (await chooseAttachment(page)).setFiles(note);
        await expect.poll(() => ready.count()).toBe(2);
        expect(await page.locator(".agent-chat__file-input").inputValue()).toBe("");
      });
    });

    it.each(
      attachmentBrowserFixtures.filter((fixture) =>
        [
          "iPhone Safari",
          "iPad desktop Safari",
          "Android Chrome",
          "macOS Safari",
          "iOS native",
          "unknown",
        ].includes(fixture.name),
      ),
    )(`keeps the single Attachment menu for $name in ${route}`, async (fixture) => {
      await suite.withPage(
        {
          userAgent: fixture.userAgent,
          hasTouch: fixture.touch > 0,
          viewport: { width: 390, height: 844 },
        },
        async ({ page }) => {
          await installAttachmentBrowserIdentity(page, fixture);
          await installMockGateway(page, { historyMessages: [] });
          await page.goto(suite.server.baseUrl + route);
          await openAttachmentMenu(page);
          await expectSingleAttachmentMenu(page);
          const pending = page.waitForEvent("filechooser");
          await page.locator('.agent-chat__attach-menu-option[value="file"]').press("Enter");
          const chooser = await pending;
          expect(await chooser.element().getAttribute("class")).toBe("agent-chat__file-input");
          expect(chooser.isMultiple()).toBe(true);
          expect(await chooser.element().getAttribute("capture")).toBeNull();
          await chooser.setFiles([]);
          expect(await page.locator(".chat-attachment-thumb").count()).toBe(0);
        },
      );
    });
  }
});
