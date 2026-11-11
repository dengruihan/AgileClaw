import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
const suite = createChatFlowE2eSuite();
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";

type ChatFlowPage = Parameters<
  Parameters<ReturnType<typeof createChatFlowE2eSuite>["withPage"]>[1]
>[0]["page"];

const LIVE_BUBBLE = ".chat-bubble.streaming";
const LAST_THREAD_TEXT = ".chat-thread-inner .chat-text";

// Sampling runs inside the page on the frame the reveal paints, so every
// sample is one presentation step and assertions do not depend on host
// round-trip latency or fixed sleeps.
async function sampleReveal(
  page: ChatFlowPage,
  selector: string,
  durationMs: number,
): Promise<{ lengths: number[]; text: string; codeBlocks: number }> {
  return page.evaluate(
    ({ selector: target, durationMs: windowMs }) =>
      new Promise<{ lengths: number[]; text: string; codeBlocks: number }>((resolve) => {
        const lengths: number[] = [];
        const startedAt = performance.now();
        const nodes = () => [...document.querySelectorAll<HTMLElement>(target)];
        const currentElement = (): HTMLElement | undefined =>
          nodes().at(-1) ??
          [...document.querySelectorAll<HTMLElement>(".chat-thread-inner .chat-text")].at(-1);
        const readText = (): string => {
          // The row drops its streaming class when the reveal completes, which
          // is the state the settled-final assertions read.
          const element = currentElement();
          return (
            element?.querySelector(".chat-text")?.textContent ??
            element?.textContent ??
            ""
          ).trim();
        };
        const tick = () => {
          lengths.push(readText().length);
          if (performance.now() - startedAt < windowMs) {
            requestAnimationFrame(tick);
            return;
          }
          resolve({
            lengths,
            text: readText(),
            codeBlocks: currentElement()?.querySelectorAll("pre").length ?? 0,
          });
        };
        requestAnimationFrame(tick);
      }),
    { selector, durationMs },
  );
}

// The buffer caps a single step, so a backlog may not paste whole paragraphs
// between two animation frames.
const MAX_REVEAL_STEP = 96;

// Partial Markdown repair can retract a marker it had shown mid-token, so the
// painted plain text may dip by a couple of characters; it never advances by
// more than one reveal step.
const MAX_MARKDOWN_REPAIR_DIP = 4;

function gradualLengths(sample: { lengths: number[] }): number[] {
  const painted = sample.lengths.filter((length) => length > 0);
  expect(painted.length).toBeGreaterThan(1);
  for (let index = 1; index < painted.length; index += 1) {
    const step = painted[index]! - painted[index - 1]!;
    expect(step).toBeLessThanOrEqual(MAX_REVEAL_STEP);
    expect(step).toBeGreaterThanOrEqual(-MAX_MARKDOWN_REPAIR_DIP);
  }
  const final = painted.at(-1)!;
  expect(final).toBeGreaterThanOrEqual(Math.max(...painted) - MAX_MARKDOWN_REPAIR_DIP);
  expect(painted.some((length) => length > 0 && length < final)).toBe(true);
  return painted;
}

async function waitForThreadText(page: ChatFlowPage, expected: string) {
  await expect
    .poll(
      () =>
        page.evaluate(
          (selector) =>
            (
              [...document.querySelectorAll<HTMLElement>(selector)].at(-1)?.textContent ?? ""
            ).trim(),
          LAST_THREAD_TEXT,
        ),
      { timeout: 15_000 },
    )
    .toBe(expected);
}

async function openStreamingTurn(page: ChatFlowPage, prompt: string) {
  const gateway = await installMockGateway(page);
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
  await gateway.waitForRequest("chat.startup");
  await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  const sendRequest = await gateway.waitForRequest("chat.send");
  const runId = requireString(
    requireRecord(sendRequest.params).idempotencyKey,
    "chat send idempotency key",
  );
  let accumulated = "";
  const emitDelta = (text: string) => {
    // Chat delta events carry the accumulated reply; the pane replaces
    // `chatStream` with the event's message text.
    accumulated += text;
    return gateway.emitGatewayEvent("chat", {
      deltaText: text,
      message: {
        content: [{ text: accumulated, type: "text" }],
        role: "assistant",
        timestamp: Date.now(),
      },
      runId,
      sessionKey: "main",
      state: "delta",
    });
  };
  return { gateway, runId, emitDelta };
}

function artifactDirFor(scope: string): string | undefined {
  const parent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
  return parent ? createControlUiE2eArtifactDir(scope, parent) : undefined;
}

suite.define(() => {
  it("reveals a bursty delta stream smoothly and pauses when it catches up", async () => {
    const artifactDir = artifactDirFor("chat-flow.smooth-reveal");
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        recordVideo: artifactDir
          ? { dir: path.join(artifactDir, "video"), size: { width: 1280, height: 900 } }
          : undefined,
      },
      async ({ page }) => {
        const { gateway, runId, emitDelta } = await openStreamingTurn(page, "smooth reveal burst");
        const firstChunk = "First twenty chars..";
        expect(firstChunk).toHaveLength(20);
        await emitDelta(firstChunk);
        await page.locator(LIVE_BUBBLE).waitFor({ state: "visible" });

        const initial = await sampleReveal(page, LIVE_BUBBLE, 900);
        const initialLengths = gradualLengths(initial);
        expect(initial.text).toBe(firstChunk);
        expect(initialLengths.at(-1)).toBe(firstChunk.length);
        // Copy and reply sources keep the canonical arrived text while the body
        // is still revealing.
        expect(await page.locator(LIVE_BUBBLE).first().getAttribute("data-message-text")).toBe(
          firstChunk,
        );
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, "state-initial-chunk.png") });
        }

        // Caught up: the row holds still until later text arrives.
        const paused = await sampleReveal(page, LIVE_BUBBLE, 400);
        expect(new Set(paused.lengths)).toEqual(new Set([firstChunk.length]));
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, "state-paused-buffer.png") });
        }

        const secondChunk = "Second chunk grows line by line. ".repeat(2).slice(0, 40);
        await emitDelta(secondChunk);
        const resumed = await sampleReveal(page, LIVE_BUBBLE, 1200);
        const resumedLengths = gradualLengths(resumed);
        expect(resumedLengths[0]).toBeGreaterThanOrEqual(firstChunk.length);
        expect(resumed.text).toBe(`${firstChunk}${secondChunk}`.trim());
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, "state-resumed-backlog.png") });
        }

        const thirdChunk = "Third chunk keeps the same readable pace. ".repeat(2).slice(0, 40);
        await emitDelta(thirdChunk);
        const caughtUp = await sampleReveal(page, LIVE_BUBBLE, 1200);
        gradualLengths(caughtUp);
        expect(caughtUp.text).toBe(`${firstChunk}${secondChunk}${thirdChunk}`.trim());

        // The settled final drains whatever the reveal still owes, exactly.
        const finalText = `${firstChunk}${secondChunk}${thirdChunk} Final sentence lands whole.`;
        await gateway.emitChatFinal({ runId, text: finalText });
        await waitForThreadText(page, finalText.trim());
        await page.locator(LIVE_BUBBLE).waitFor({ state: "detached", timeout: 15_000 });
      },
    );
  });

  it("reveals a one-shot non-streaming final instead of snapping it in", async () => {
    const artifactDir = artifactDirFor("chat-flow.smooth-reveal");
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { gateway, runId } = await openStreamingTurn(page, "one-shot final probe");
      const finalText = [
        "A one-shot provider answer arrives whole.",
        "",
        "Second paragraph keeps **strong emphasis** and a fenced block:",
        "",
        "```ts",
        "const answer = 42;",
        "```",
      ].join("\n");
      await gateway.emitChatFinal({ runId, text: finalText });
      const sampled = await sampleReveal(page, LIVE_BUBBLE, 1500);
      const painted = gradualLengths(sampled);
      expect(painted.at(-1)).toBeGreaterThanOrEqual(sampled.text.length - MAX_REVEAL_STEP);
      expect(sampled.text).toContain("A one-shot provider answer arrives whole.");
      expect(sampled.text).toContain("Second paragraph keeps strong emphasis and a fenced block:");
      expect(sampled.text).toContain("const answer = 42;");
      expect(sampled.codeBlocks).toBe(1);
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "state-markdown-code.png") });
      }
      await expect
        .poll(
          () =>
            page.evaluate(
              (selector) =>
                ([...document.querySelectorAll<HTMLElement>(selector)].at(-1)?.textContent ?? "")
                  .trim()
                  .includes("const answer = 42;"),
              LAST_THREAD_TEXT,
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      expect(await page.locator(".chat-thread-inner strong").last().textContent()).toBe(
        "strong emphasis",
      );
      await page.locator(LIVE_BUBBLE).waitFor({ state: "detached", timeout: 15_000 });
      await expect
        .poll(() => page.locator(".chat-group.assistant:last-of-type .chat-group-footer").count(), {
          timeout: 10_000,
        })
        .toBe(1);
    });
  });

  it("drains a long backlog without jumping whole paragraphs", async () => {
    const artifactDir = artifactDirFor("chat-flow.smooth-reveal");
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { emitDelta } = await openStreamingTurn(page, "long backlog probe");
      const backlog = Array.from(
        { length: 12 },
        (_, index) =>
          `Paragraph ${index + 1}: ${"a long answer keeps arriving. ".repeat(6).trim()}`,
      ).join("\n\n");
      await emitDelta(backlog);
      await page.locator(LIVE_BUBBLE).waitFor({ state: "visible" });
      const sampled = await sampleReveal(page, LIVE_BUBBLE, 5000);
      gradualLengths(sampled);
      expect(sampled.text.length).toBeGreaterThan(1_500);
      expect(sampled.text).toContain("Paragraph 1: a long answer keeps arriving.");
      expect(sampled.text).toContain("Paragraph 12: a long answer keeps arriving.");
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "state-long-response.png") });
      }
    });
  });

  it("reveals whole grapheme clusters (flags, ZWJ families, keycaps)", async () => {
    const artifactDir = artifactDirFor("chat-flow.smooth-reveal");
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { gateway, runId } = await openStreamingTurn(page, "grapheme reveal probe");
      const finalText = "Flags 🇨🇳🇯🇵 and a family 👨‍👩‍👧‍👦 plus keycap 1️⃣ and modifier 👍🏽 stay whole.";
      await gateway.emitChatFinal({ runId, text: finalText });
      const boundaries = await page.evaluate(
        (text) =>
          new Promise<{ samples: number[]; boundaries: number[]; text: string }>((resolve) => {
            const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
            const boundarySet = new Set<number>();
            for (const segment of segmenter.segment(text)) {
              boundarySet.add(segment.index);
              boundarySet.add(segment.index + segment.segment.length);
            }
            const samples: number[] = [];
            const startedAt = performance.now();
            const readText = () => {
              const nodes = [...document.querySelectorAll<HTMLElement>(".chat-text")];
              return (nodes.at(-1)?.textContent ?? "").trim();
            };
            const tick = () => {
              samples.push(readText().length);
              if (performance.now() - startedAt < 1200) {
                requestAnimationFrame(tick);
                return;
              }
              resolve({ samples, boundaries: [...boundarySet], text: readText() });
            };
            requestAnimationFrame(tick);
          }),
        finalText,
      );
      const painted = boundaries.samples.filter((length) => length > 0);
      expect(painted.length).toBeGreaterThan(1);
      expect(painted.every((length) => boundaries.boundaries.includes(length))).toBe(true);
      expect(boundaries.text).toBe(finalText);
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "state-graphemes.png") });
      }
    });
  });

  it("paints settled text immediately under reduced motion", async () => {
    const artifactDir = artifactDirFor("chat-flow.smooth-reveal");
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), reducedMotion: "reduce" },
      async ({ page }) => {
        const { emitDelta } = await openStreamingTurn(page, "reduced motion probe");
        const chunk = "Reduced motion paints this chunk immediately without a reveal.";
        await emitDelta(chunk);
        await page.locator(LIVE_BUBBLE).waitFor({ state: "visible" });
        const sampled = await sampleReveal(page, LIVE_BUBBLE, 300);
        expect(sampled.text).toBe(chunk);
        expect(new Set(sampled.lengths.filter((length) => length > 0))).toEqual(
          new Set([chunk.length]),
        );
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, "state-reduced-motion.png") });
        }
      },
    );
  });
});
