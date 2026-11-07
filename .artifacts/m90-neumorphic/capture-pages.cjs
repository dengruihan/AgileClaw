/* M90 before/after capture: 5 pages × desktop/narrow × light/dark.
 * Task-owned proof helper; not part of the shipped source tree. */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const phase = process.argv[2] === "after" ? "after" : "before";
const baseUrl = process.env.M90_BASE_URL ?? "http://localhost:4190";
const outRoot = path.join(__dirname, phase);
fs.mkdirSync(outRoot, { recursive: true });

const pages = [
  {
    name: "home",
    url: "/new",
    ready: ".shell",
    // New Session is the actual Home surface; a mounted shell can still be
    // restoring the route, so require the rendered Molty heading and composer.
    homeReady: {
      heading: ".new-session-page__scroll h2",
      composer: ".new-session-page__message",
    },
  },
  {
    name: "chat",
    url: "/chat/main",
    ready: ".shell",
    // A chat capture must be a real transcript, never the New Session surface
    // the /chat route falls back to while no session is selected.
    chatReady: ".chat-thread .chat-group",
  },
  { name: "dashboards", url: "/dashboards", ready: ".shell" },
  { name: "settings-appearance", url: "/settings/appearance", ready: ".shell" },
  { name: "passwords-vault", url: "/settings/passwords", ready: ".shell" },
];
const viewports = {
  desktop: { width: 1440, height: 900 },
  narrow: { width: 390, height: 844 },
};

(async () => {
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const [vpName, viewport] of Object.entries(viewports)) {
        const context = await browser.newContext({
          viewport,
          colorScheme: scheme,
          deviceScaleFactor: 2,
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        // Seed the persisted selection once (first load creates the settings
        // record), then reload so the app boots with the intended theme.
        if (process.env.M90_THEME) {
          await page.goto(baseUrl + "/new", { waitUntil: "domcontentloaded" });
          await page.locator(".shell").first().waitFor({ state: "visible", timeout: 20000 });
          await page.evaluate((theme) => {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (!key || !key.startsWith("openclaw.control.settings.v1")) continue;
              try {
                const parsed = JSON.parse(localStorage.getItem(key));
                if (parsed && typeof parsed === "object") {
                  parsed.theme = theme;
                  delete parsed.accent;
                  delete parsed.customTheme;
                  localStorage.setItem(key, JSON.stringify(parsed));
                }
              } catch {}
            }
          }, process.env.M90_THEME);
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.locator(".shell").first().waitFor({ state: "visible", timeout: 20000 });
          const seeded = await page.evaluate(() => document.documentElement.dataset.theme);
          const want = process.env.M90_THEME;
          if (seeded !== want && seeded !== `${want}-light`) {
            throw new Error(`theme seed failed: ${seeded}`);
          }
        }
        for (const target of pages) {
          const file = path.join(outRoot, `${target.name}--${vpName}--${scheme}.png`);
          try {
            await page.goto(baseUrl + target.url, { waitUntil: "domcontentloaded" });
            await page.locator(target.ready).first().waitFor({ state: "visible", timeout: 20000 });
            if (target.homeReady) {
              await page
                .locator(target.homeReady.heading, { hasText: "Molty" })
                .first()
                .waitFor({ state: "visible", timeout: 20000 });
              const composer = page.locator(target.homeReady.composer).first();
              await composer.waitFor({ state: "visible", timeout: 20000 });
              const ready = await composer.evaluate(
                (element) => !(element instanceof HTMLTextAreaElement) || !element.disabled,
              );
              if (!ready) {
                throw new Error("New Session composer is not enabled");
              }
              if (new URL(page.url()).pathname !== "/new") {
                throw new Error(`home route did not stay on /new: ${page.url()}`);
              }
            }
            if (target.chatReady) {
              await page.locator(target.chatReady).first().waitFor({
                state: "visible",
                timeout: 20000,
              });
              if (!new URL(page.url()).pathname.includes("/chat/")) {
                throw new Error(`chat route did not open a session: ${page.url()}`);
              }
            }
            await page.evaluate(() => {
              const root = document.documentElement;
              return { theme: root.dataset.theme, mode: root.dataset.themeMode };
            }).then((state) => {
              if (state.mode !== scheme) {
                throw new Error(`expected mode ${scheme}, got ${JSON.stringify(state)}`);
              }
            });
            await page.waitForTimeout(200);
            await page.screenshot({ animations: "disabled", path: file });
            process.stdout.write(`ok ${path.basename(file)}\n`);
          } catch (error) {
            process.stdout.write(`FAIL ${path.basename(file)}: ${error.message}\n`);
            await page.screenshot({ animations: "disabled", path: file.replace(/\.png$/, "--error.png") }).catch(() => {});
          }
        }
        if (errors.length) {
          process.stdout.write(`page errors (${scheme}/${vpName}): ${errors.slice(0, 3).join(" | ")}\n`);
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
})();
