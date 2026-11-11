import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  takeControlUiElementScreenshot,
  takeControlUiViewportScreenshot,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "chat formula rendering" });

const HOSTILE_HOST = "evil.invalid";
const GALLERY_STORAGE_KEY = "agileclaw-chat-formula-gallery-20261111-v1";

/**
 * Every formula form from the reported session, with synthetic prose around it.
 * Each example is its own message so the gallery can point at one real capture.
 */
const FORMULA_EXAMPLES = [
  {
    id: "inline",
    label: "Inline dollar and backslash math",
    note: "Both inline delimiters from the session report; the fallback source is gone once typeset.",
    text: String.raw`Example inline: the energy relation is $E = mc^2$ and the ratio is \(\frac{v}{c}\) for this part.`,
  },
  {
    id: "display",
    label: "Display block on its own lines",
    note: "A fenced $$ block becomes one centered equation instead of a paragraph.",
    text: ["Example display:", "", "$$", String.raw`\int_0^1 x^2\,dx = \frac{1}{3}`, "$$"].join(
      "\n",
    ),
  },
  {
    id: "table",
    label: "Math inside table cells",
    note: "Inline math tokenizes inside table cells while the table controls stay intact.",
    text: [
      "Example table:",
      "",
      "| Quantity | Formula |",
      "| --- | --- |",
      String.raw`| area | $\pi r^2$ |`,
      String.raw`| period | \(2\pi\sqrt{\ell/g}\) |`,
    ].join("\n"),
  },
  {
    id: "blockquote",
    label: "Display math inside a blockquote",
    note: "Display math keeps the quote container and centers inside it.",
    text: ["Example blockquote:", "", "> The identity holds:", ">", "> $$e^{i\\pi} + 1 = 0$$"].join(
      "\n",
    ),
  },
  {
    id: "code",
    label: "Code spans and fences keep their dollars",
    note: "Code spans and fences never tokenize; shell variables stay literal.",
    text: [
      "Example code:",
      "",
      "```bash",
      'echo "$HOME and $PATH"',
      "```",
      "",
      "`$5` stays literal.",
    ].join("\n"),
  },
  {
    id: "currency",
    label: "Ordinary currency stays prose",
    note: "Amounts render as plain text; no placeholder element exists.",
    text: "Example currency: fees are $5 and $10, or $1.50 for the small one.",
  },
  {
    id: "invalid",
    label: "Invalid and unclosed TeX stays readable",
    note: "KaTeX throwOnError:false keeps the authored source visible beside the error marker.",
    text: String.raw`Example invalid: broken $\frac{1}$ and unmatched $$ delimiters.`,
  },
  {
    id: "long",
    label: "Long display formula",
    note: "The display equation scrolls inside its own box instead of widening the transcript.",
    text: [
      "Example long:",
      "",
      "$$",
      String.raw`\sum_{k=1}^{n} \frac{\alpha_k \beta_k}{\gamma_k + \delta_k} + \prod_{j=1}^{m} \left(1 - \frac{x_j}{y_j}\right) = \frac{\partial}{\partial t}\int_{\Omega} \rho(x,t)\,dx`,
      "$$",
    ].join("\n"),
  },
  {
    id: "hostile",
    label: "Hostile TeX payloads stay inert",
    note: "Real transcript render with trust:false; no link, image, or remote request exists in the DOM.",
    text: String.raw`Example hostile: $\href{javascript:alert(1)}{tap}$ and $\includegraphics{https://${HOSTILE_HOST}/pixel.png}$ payloads.`,
  },
] as const;

type GalleryExample = { id: string; label: string; image: string; note: string };

function historyMessages(
  examples: readonly (typeof FORMULA_EXAMPLES)[number][] = FORMULA_EXAMPLES,
) {
  return examples.map((example, index) => ({
    content: [{ type: "text", text: example.text }],
    role: "assistant" as const,
    timestamp: index + 1,
  }));
}

function trackMathRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (/katex/i.test(request.url())) {
      urls.push(request.url());
    }
  });
  return urls;
}

function messageText(page: Page, marker: string): Locator {
  return page.locator(".chat-group.assistant .chat-text", { hasText: marker });
}

async function waitForRenderedMath(page: Page, expected: number): Promise<void> {
  await expect
    .poll(() => page.locator('openclaw-chat-math[data-math-state="rendered"]').count(), {
      timeout: 20_000,
    })
    .toBe(expected);
}

async function openFormulaChat(page: Page): Promise<void> {
  await installMockGateway(page, { historyMessages: historyMessages() });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
  await messageText(page, "Example inline").waitFor();
  await waitForRenderedMath(page, 10);
}

function galleryHtml(examples: readonly GalleryExample[]): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenClaw chat formula rendering · review gallery</title><style>:root{font:15px/1.55 system-ui;background:#f4f1ec;color:#262421}*{box-sizing:border-box}body{margin:0;padding:28px}header,main{max-width:1400px;margin:auto}h1{color:#c44730;margin-bottom:8px}button{font:inherit;padding:10px 16px;border:1px solid #c44730;border-radius:10px;background:#c44730;color:#fff;cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr));gap:24px;margin-top:24px}article{border:1px solid #ddd5ca;border-radius:16px;background:#fff;overflow:hidden}article h2,article p,article label{margin:14px 18px;display:block}article img{display:block;width:100%;background:#eeebe6;object-fit:contain;object-position:top;max-height:420px}small{color:#68605b}textarea{font:inherit;display:block;width:100%;resize:vertical;min-height:72px;padding:10px;border:1px solid #d6cdc4;border-radius:8px;margin-top:6px}#status{margin-left:12px}</style><header><h1>OpenClaw chat formula rendering</h1><p>Real Control UI chat components rendered from a mocked Gateway session with KaTeX 0.16.47 loaded lazily on demand. Every capture comes from the same transcript; only viewport, theme, and reduced-motion preference change. Example IDs and your comments stay stable.</p><p><button id="copy" type="button">Copy feedback</button><span id="status" role="status"></span></p></header><main class="grid">${examples
    .map(
      (example) =>
        `<article id="${example.id}"><h2>${example.label}</h2><p><small>Example ID: ${example.id}. ${example.note}</small></p><a href="${example.image}" target="_blank"><img src="${example.image}" alt="${example.label}"></a><label for="feedback-${example.id}">Feedback · ${example.label}<textarea id="feedback-${example.id}" data-id="${example.id}" data-label="${example.label}" placeholder="What should this equation show or do differently?"></textarea></label></article>`,
    )
    .join(
      "",
    )}</main><script>const key=${JSON.stringify(GALLERY_STORAGE_KEY)};const inputs=[...document.querySelectorAll("textarea")];let saved={};try{saved=JSON.parse(localStorage.getItem(key)||"{}")}catch{}for(const input of inputs){input.value=saved[input.dataset.id]||'';input.addEventListener("input",()=>{saved[input.dataset.id]=input.value;localStorage.setItem(key,JSON.stringify(saved))})}document.getElementById("copy").addEventListener("click",async()=>{const out=inputs.map(input=>'## '+input.dataset.id+' — '+input.dataset.label+'\\n'+(input.value.trim()||'(No comment)')).join('\\n\\n');try{await navigator.clipboard.writeText(out);document.getElementById("status").textContent='Feedback copied.'}catch{document.getElementById("status").textContent='Clipboard unavailable. Select and copy the feedback below.';const box=document.createElement('textarea');box.value=out;document.querySelector('header').append(box);box.select()}})</script></html>`;
}

suite.define(() => {
  it("renders every reported formula form from mocked history", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1280 },
      },
      async ({ page }) => {
        const mathRequests = trackMathRequests(page);
        await openFormulaChat(page);

        const inline = messageText(page, "Example inline");
        expect(await inline.locator(".katex").count()).toBe(2);
        expect(await inline.locator(".openclaw-chat-math__source").count()).toBe(0);
        expect(await inline.textContent()).not.toContain("$$");
        const inlineVisible = (await inline.locator(".katex-html").allTextContents()).join(" ");
        expect(inlineVisible).not.toContain(String.raw`\frac`);

        const display = messageText(page, "Example display");
        expect(await display.locator(".openclaw-chat-math--display .katex-display").count()).toBe(
          1,
        );

        const table = messageText(page, "Example table");
        expect(await table.locator("td .katex").count()).toBe(2);
        expect(await table.locator(".markdown-table").count()).toBe(1);

        const blockquote = messageText(page, "Example blockquote");
        expect(await blockquote.locator("blockquote .katex-display").count()).toBe(1);

        const code = messageText(page, "Example code");
        expect(await code.locator("pre code").textContent()).toContain("$HOME and $PATH");
        expect(await code.locator("pre code .katex").count()).toBe(0);
        expect(await code.textContent()).toContain("$5 stays literal");

        const currency = messageText(page, "Example currency");
        expect(await currency.textContent()).toContain("$5 and $10");
        expect(await currency.locator("openclaw-chat-math").count()).toBe(0);

        const invalid = messageText(page, "Example invalid");
        expect(await invalid.locator(".katex-error").count()).toBe(1);
        expect(await invalid.textContent()).toContain(String.raw`\frac{1}`);

        const long = messageText(page, "Example long");
        expect(await long.locator(".openclaw-chat-math--display").count()).toBe(1);
        expect(
          await long.locator(".openclaw-chat-math--display").evaluate((element) => {
            const style = getComputedStyle(element);
            return { overflowX: style.overflowX, maxWidth: style.maxWidth };
          }),
        ).toEqual({ overflowX: "auto", maxWidth: "100%" });

        const hostile = messageText(page, "Example hostile");
        expect(await hostile.locator("openclaw-chat-math").count()).toBe(2);
        expect(await hostile.locator("a[href^='javascript']").count()).toBe(0);
        expect(await hostile.locator("img").count()).toBe(0);
        expect(mathRequests.some((url) => url.includes(HOSTILE_HOST))).toBe(false);
        expect(mathRequests.some((url) => /katex/i.test(url))).toBe(true);

        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        ).toBe(true);

        // One inspected capture per review example, all from this real transcript.
        const captures = new Map<string, string>();
        for (const example of FORMULA_EXAMPLES) {
          const surface = messageText(page, `Example ${example.id}`);
          await surface.scrollIntoViewIfNeeded();
          const image = `example-${example.id}.png`;
          await writeFile(
            path.join(suite.artifactDir, image),
            await takeControlUiElementScreenshot(page, surface, [
              surface.locator(":scope > *").first(),
            ]),
          );
          captures.set(example.id, image);
        }

        await writeFile(
          path.join(suite.artifactDir, "desktop-light.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".chat-thread"), [
            messageText(page, "Example long"),
          ]),
        );
        captures.set("desktop-light", "desktop-light.png");

        // The table toolbar copies the delimited source, not MathML plus the
        // TeX annotation plus the visual tree.
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await table.locator(".markdown-table__copy").click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe("Quantity\tFormula\narea\t$\\pi r^2$\nperiod\t\\(2\\pi\\sqrt{\\ell/g}\\)");

        const displaySurface = messageText(page, "Example display");
        await page.evaluate(() => {
          document.documentElement.dataset.themeMode = "dark";
        });
        await writeFile(
          path.join(suite.artifactDir, "dark.png"),
          await takeControlUiElementScreenshot(page, displaySurface, [
            displaySurface.locator(".openclaw-chat-math--display"),
          ]),
        );
        captures.set("dark", "dark.png");

        await page.setViewportSize({ width: 400, height: 900 });
        await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
        await page.evaluate(() => {
          document.documentElement.dataset.themeMode = "dark";
        });
        await displaySurface.locator(".katex-display").waitFor({ state: "visible" });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        ).toBe(true);
        await writeFile(
          path.join(suite.artifactDir, "narrow-dark.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".chat-thread"), [
            messageText(page, "Example long"),
          ]),
        );
        captures.set("narrow-dark", "narrow-dark.png");

        await writeFile(
          path.join(suite.artifactDir, "gallery.html"),
          galleryHtml([
            ...FORMULA_EXAMPLES.map((example) => ({
              id: example.id,
              label: example.label,
              image: captures.get(example.id)!,
              note: example.note,
            })),
            {
              id: "desktop-light",
              label: "Whole transcript · desktop light",
              image: captures.get("desktop-light")!,
              note: "1280 × 1000 viewport over the same mocked history; no page-level horizontal overflow.",
            },
            {
              id: "dark",
              label: "Display block · dark theme",
              image: captures.get("dark")!,
              note: "Dark theme contrast for a display equation from the same transcript.",
            },
            {
              id: "narrow-dark",
              label: "Whole transcript · 400 px dark, reduced motion",
              image: captures.get("narrow-dark")!,
              note: "400 × 900 dark viewport with prefers-reduced-motion: reduce; display math scrolls inside its own box.",
            },
          ]),
        );
      },
    );
  });

  it("keeps KaTeX out of new-session startup and loads it for chat math", async () => {
    await suite.withPage(
      { colorScheme: "light", locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const mathRequests = trackMathRequests(page);
        await installMockGateway(page, {
          historyMessages: historyMessages([FORMULA_EXAMPLES[0]]),
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        expect(await page.locator("openclaw-chat-math").count()).toBe(0);
        expect(mathRequests).toEqual([]);

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        await waitForRenderedMath(page, 2);
        // The built bundle keeps KaTeX in its own lazy chunk and stylesheet.
        expect(mathRequests.some((url) => /katex-[\w-]+\.js/i.test(url))).toBe(true);
        expect(mathRequests.some((url) => /katex-[\w-]+\.css/i.test(url))).toBe(true);
        expect(mathRequests.some((url) => /KaTeX_.*\.woff2/i.test(url))).toBe(true);
      },
    );
  });

  it("keeps a long equation scrollable inside a 400 px dark viewport with reduced motion", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        reducedMotion: "reduce",
        serviceWorkers: "block",
        viewport: { height: 900, width: 400 },
      },
      async ({ page }) => {
        await openFormulaChat(page);
        const long = messageText(page, "Example long");
        await long.locator(".katex-display").waitFor({ state: "visible" });
        expect(
          await long.locator(".openclaw-chat-math--display").evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              opacity: style.opacity,
              animationName: style.animationName,
              transitionDuration: style.transitionDuration,
              overflowX: style.overflowX,
            };
          }),
        ).toEqual({
          opacity: "1",
          animationName: "none",
          transitionDuration: "0s",
          overflowX: "auto",
        });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        ).toBe(true);
      },
    );
  });
});
