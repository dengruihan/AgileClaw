import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const viewport of [
      { label: "desktop", width: 800 },
      { label: "mobile", width: 760 },
    ] as const) {
      it(`keeps the ${viewport.label} header chrome aligned without identity crumbs in ${colorScheme} mode`, async () => {
        const context = await suite.newBrowserContext({
          colorScheme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 520, width: viewport.width },
        });
        const page = await context.newPage();
        const sessionRequests: string[] = [];
        page.on("request", (request) => {
          const url = request.url();
          if (url.includes("/__openclaw__/workspace-icon/")) {
            sessionRequests.push(`icon:${url}`);
          }
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.list": chatSessionListResponse([
              {
                key: "agent:main:parent",
                kind: "direct",
                label: "Release readiness and production rollout coordination",
                spawnedCwd: "/repo/openclaw",
                updatedAt: 1,
              },
              {
                key: "agent:main:session-a",
                kind: "direct",
                label: "Implement parent breadcrumb navigation and polish overflow behavior",
                parentSessionKey: "agent:main:parent",
                spawnedCwd: "/repo/openclaw",
                updatedAt: 2,
              },
            ]),
          },
          sessionKey: "agent:main:session-a",
        });

        try {
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
          const header = page.locator(
            "openclaw-chat-pane.chat-pane-cache__pane--active .chat-pane__header",
          );
          await header.waitFor();

          // Identity breadcrumbs are gone entirely: no project chip, session
          // title, or parent trail may render, let alone fetch a workspace icon.
          expect(
            await page
              .locator(
                ".chat-pane__crumbs, .chat-pane__workspace-chip, .chat-pane__session-title, .chat-pane__parent-session",
              )
              .count(),
          ).toBe(0);
          expect(await page.locator("openclaw-workspace-icon").count()).toBe(0);

          const geometry = await header.evaluate((root) => {
            const main = root
              .closest("openclaw-chat-pane")
              ?.querySelector('[data-region="main"]:not([hidden])');
            if (!main) {
              throw new Error("Task header requires visible main content");
            }
            const centerY = (selector: string) => {
              const node = root.querySelector(selector);
              if (!node) {
                throw new Error(`missing header element: ${selector}`);
              }
              const rect = node.getBoundingClientRect();
              return rect.top + rect.height / 2;
            };
            return {
              nav: centerY(".chat-pane__nav-toggle svg"),
              menu: centerY(".chat-header-session-menu__trigger svg"),
              headerBottom: root.getBoundingClientRect().bottom,
              contentTop: main.getBoundingClientRect().top,
            };
          });

          // The remaining chrome — drawer nav and the session menu — shares one
          // horizontal axis, and the transcript starts below the header row.
          expect(
            Math.abs(geometry.menu - geometry.nav),
            JSON.stringify(geometry),
          ).toBeLessThanOrEqual(0.1);
          expect(geometry.contentTop).toBeGreaterThanOrEqual(geometry.headerBottom - 0.1);
          if (captureUiProofEnabled) {
            await page.screenshot({
              path: path.join(
                suite.artifactDir,
                "chat-header-axis",
                `${viewport.label}-${colorScheme}.png`,
              ),
            });
          }

          // Main operations stay reachable: the session menu opens, and the
          // rename entry point now edits through a dialog instead of the
          // removed inline title editor.
          await header.locator(".chat-header-session-menu__trigger").click();
          const menu = page.locator("openclaw-chat-header-session-menu wa-dropdown");
          await menu.waitFor();
          const renameItem = menu.locator('wa-dropdown-item[value="rename"]');
          await renameItem.waitFor();
          await renameItem.click();
          const dialogInput = page.locator('openclaw-modal-dialog input[name="value"]');
          await dialogInput.waitFor();
          await expect
            .poll(() => dialogInput.inputValue())
            .toBe("Implement parent breadcrumb navigation and polish overflow behavior");
          await dialogInput.fill("Renamed from the session menu");
          await dialogInput.press("Enter");
          const patch = await waitForRequests(gateway, "sessions.patch", 1, {
            label: "Renamed from the session menu",
          });
          expect(patch).toHaveLength(1);

          // The crumb removal also retired its data loading: no workspace-icon
          // asset, platform probe, or live branch lookup may be requested.
          expect(sessionRequests).toEqual([]);
          expect(await gateway.getRequests("system.info")).toEqual([]);
          expect(await gateway.getRequests("worktrees.branches")).toEqual([]);

          // Split panes inherit the same header: opening one must not bring
          // identity crumbs back in any pane.
          const splitButton = header.locator(".chat-open-split-view");
          if (await splitButton.count()) {
            await splitButton.click();
            await page.locator(".chat-split-view__cell").nth(1).waitFor();
            expect(
              await page
                .locator(
                  ".chat-pane__crumbs, .chat-pane__session-title, .chat-pane__workspace-chip, .chat-pane__parent-session",
                )
                .count(),
            ).toBe(0);
          }
        } finally {
          await suite.closeBrowserContext(context);
        }
      });
    }
  }

  for (const viewport of [
    { height: 844, label: "portrait", width: 390 },
    { height: 393, label: "short landscape", width: 852 },
  ] as const) {
    it(`keeps compact ${viewport.label} transcript search below the task header`, async () => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: viewport.height, width: viewport.width },
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        methodResponses: { "sessions.list": chatSessionListResponse() },
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        await page.locator(".agent-chat__composer-combobox > textarea").focus();
        await page.keyboard.press("ControlOrMeta+f");
        const search = page.locator(".agent-chat__search-bar input");
        await search.waitFor();
        const [headerBox, searchBox] = await Promise.all([
          page.locator(".chat-pane__header").first().boundingBox(),
          search.boundingBox(),
        ]);
        expect(headerBox).not.toBeNull();
        expect(searchBox).not.toBeNull();
        expect(searchBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
        await search.click();
        await search.fill("reachable");
        expect(await search.inputValue()).toBe("reachable");
      } finally {
        await suite.closeBrowserContext(context);
      }
    });

    it(`preserves compact ${viewport.label} New Session composer edge margins`, async () => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: viewport.height, width: viewport.width },
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        methodResponses: { "sessions.list": chatSessionListResponse() },
      });

      try {
        await page.goto(`${suite.server.baseUrl}new`);
        const protocol = await context.newCDPSession(page);
        await protocol.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 34 } });
        const composer = page.locator(".new-session-page__composer");
        await composer.waitFor();
        await composer.scrollIntoViewIfNeeded();
        const bounds = await composer.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            draftBottom: element.closest(".new-session-page__draft")!.getBoundingClientRect()
              .bottom,
            shellBottom: element.closest(".shell")!.getBoundingClientRect().bottom,
          };
        });
        // New Session remains in its scrollable draft flow, not docked like
        // Chat. Its local 6px gap must not reserve the app's physical inset again.
        expect(bounds.shellBottom).toBeCloseTo(viewport.height - 34, 0);
        expect(bounds.draftBottom - bounds.bottom).toBeCloseTo(6, 0);
        expect(bounds.bottom).toBeLessThanOrEqual(bounds.shellBottom);
        expect(bounds.left).toBeGreaterThanOrEqual(20);
        expect(bounds.right).toBeLessThanOrEqual(viewport.width - 20);
        expect(bounds.left).toBeCloseTo(viewport.width - bounds.right, 0);
      } finally {
        await suite.closeBrowserContext(context);
      }
    });
  }
});
