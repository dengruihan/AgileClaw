import photon from "@silvia-odwyer/photon-node";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Spatial overflow fades" });
// Calibrate the real scroller with a solid paint layer, without replacing its
// mask, geometry or overflow state. Sampling the rendered pixels catches a hard
// clip even when the observer attributes and computed gradient both look valid.
// fadeBoundaryPx is the intended fully-opaque boundary from each edge: sample
// brightness must reach full legibility by that boundary (detecting a longer
// fade — e.g. the legacy 32px mask at a 14px compact boundary — as a failure).
// edgeMax caps the brightness at the very edge: a soft fade starts dimmer than
// the interior, while a hard clip line would be fully bright there.
async function expectClearEdge(
  scroller: Locator,
  expectations?: { fadeBoundaryPx?: number; edgeMax?: number },
) {
  const { fadeBoundaryPx = 34, edgeMax = 3 } = expectations ?? {};
  const page = scroller.page();
  await scroller.evaluate((element) => {
    element.setAttribute("data-fade-probe", "");
    element.parentElement!.setAttribute("data-fade-probe-parent", "");
  });
  const probe = await page.addStyleTag({
    content:
      "[data-fade-probe] { background: white !important; } [data-fade-probe] > * { visibility: hidden !important; } [data-fade-probe-parent] { background: black !important; }",
  });
  try {
    const image = photon.PhotonImage.new_from_byteslice(
      await scroller.screenshot({ animations: "disabled" }),
    );
    try {
      const width = image.get_width();
      const pixels = image.get_raw_pixels();
      const sample = (y: number) => pixels[(y * width + Math.floor(width / 2)) * 4]!;
      // Fractional locator bounds can include the parent border in the outermost
      // screenshot pixel. Start inside the scrollport, not on that rounded clip.
      for (const edge of ["top", "bottom"]) {
        const ramp = Array.from({ length: 36 }, (_, y) =>
          sample(edge === "top" ? y + 1 : image.get_height() - 2 - y),
        );
        // A soft fade may start semi-transparent at the very edge; the contract
        // is a smooth monotonic ramp, not a hard clip line.
        expect(ramp[0], `${edge}: no bright strip at the very edge`).toBeLessThanOrEqual(edgeMax);
        // The default 32px fades are near-black this early; a compressed fade
        // (the 12px compact band) legitimately sits mid-ramp at 4px, so the
        // early-row check only applies to the default calibration.
        if (!expectations) {
          expect(ramp[4], `${edge}: no bright strip at the edge`).toBeLessThan(30);
        }
        // Fully legible at the intended fade boundary — this detects a longer
        // fade (e.g. the legacy 32px mask at the 14px compact boundary), where
        // the sample still sits mid-ramp.
        expect(
          sample(fadeBoundaryPx + 2),
          `${edge}: interior stays fully legible at the ${fadeBoundaryPx}px boundary`,
        ).toBeGreaterThanOrEqual(250);
        expect(ramp[35], `${edge}: interior stays fully legible`).toBeGreaterThanOrEqual(250);
        for (let y = 1; y < ramp.length; y++) {
          const step = ramp[y]! - ramp[y - 1]!;
          expect(step, `${edge}: opacity does not reverse at pixel ${y}`).toBeGreaterThanOrEqual(
            -1,
          );
          expect(step, `${edge}: no abrupt opacity jump at pixel ${y}`).toBeLessThan(25);
        }
      }
    } finally {
      image.free();
    }
  } finally {
    await probe.evaluate((el) => el.parentNode?.removeChild(el));
    await scroller.evaluate((el) => {
      el.removeAttribute("data-fade-probe");
      el.parentElement!.removeAttribute("data-fade-probe-parent");
    });
  }
}

suite.define(() => {
  it.each([390, 1280])("preserves scroll endpoints and controls at %ipx", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 800 }, colorScheme: "dark", reducedMotion: "reduce" },
      async ({ page }) => {
        const key = "agent:main:dashboard:fade-proof";
        const sessions = Array.from({ length: 40 }, (_, i) => ({
          key: i === 0 ? key : `agent:main:dashboard:proof-${i}`,
          label: i === 0 ? "Review overflow fades" : `Design review ${i}`,
          kind: "direct",
          updatedAt: 40 - i,
        }));
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          methodResponses: {
            "sessions.list": {
              count: sessions.length,
              defaults: { contextTokens: null, model: "example-model", modelProvider: "example" },
              path: "",
              sessions,
              ts: Date.now(),
            },
          },
          historyMessages: [{ role: "assistant", content: "Review the overflow edges." }],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        if (width > 768) {
          // The list intentionally shows only ten rows until expanded; use the
          // same short viewport as the existing sidebar containment regression.
          await page.setViewportSize({ width, height: 500 });
          const sidebar = page.locator(".sidebar-sessions__scroll");
          await expect.poll(() => sidebar.getAttribute("class")).toContain("scroll-top");
          await sidebar.evaluate((el) => {
            el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
          });
          await expect.poll(() => sidebar.getAttribute("class")).toContain("scroll-middle");
          // The ≤500px sidebar band intentionally uses the compact 12px
          // edge fade; calibrate against that boundary, not the 32px one.
          await expectClearEdge(sidebar, { fadeBoundaryPx: 14, edgeMax: 40 });
          await sidebar.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          await expect.poll(() => sidebar.getAttribute("class")).toContain("scroll-bottom");
          await page.setViewportSize({ width, height: 800 });
        }
        await gateway.setOnline(false);
        await gateway.closeLatest();
        for (let i = 1; i <= 7; i++) {
          await composer.fill(`Review item ${i}: verify smooth edges and readable content`);
          await composer.press("Enter");
          await page.locator(".chat-queue__item", { hasText: `Review item ${i}:` }).waitFor();
        }
        const queue = page.locator(".chat-queue__scroll");
        await expect.poll(() => queue.getAttribute("data-scrollable")).toBe("true");
        await queue.evaluate((el) => {
          el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
        });
        await expect.poll(() => queue.getAttribute("data-at-start")).toBe("false");
        await expect.poll(() => queue.getAttribute("data-at-end")).toBe("false");
        await expectClearEdge(queue);
        await queue.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await expect.poll(() => queue.getAttribute("data-at-end")).toBe("true");
        const last = queue.locator(".chat-queue__item").last().locator(".chat-queue__grip");
        await last.focus();
        expect(await last.evaluate((el) => el.matches(":focus"))).toBe(true);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
      },
    );
  });
});
