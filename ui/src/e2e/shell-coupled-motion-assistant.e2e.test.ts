import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openAssistantDock } from "./assistant-dock.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// Assistant dock motion window: the second conversation must not land inside the
// 200ms open/close/reversal window, and its mount is staged one frame behind the
// dock pane's own frame. The full shell geometry suite lives in
// shell-coupled-motion.e2e.test.ts.
const suite = createControlUiE2eSuite({
  name: "Control UI shell motion assistant dock",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

const SESSION_KEY = "agent:main:main";
const DOCK_PARAMS = { sessionKey: "agent:main:dock", agentId: "main", label: "Dock" };

declare global {
  interface Window {
    openclawDockCloseFrame?: number;
    openclawDockCloseFrames?: Array<{
      contentMounted: boolean;
      sessionMounted: boolean;
      width: number;
    }>;
    openclawDockStageFrame?: number;
    openclawDockStageFrames?: Array<{
      conversation: boolean;
      pane: boolean;
      staged: boolean | null;
    }>;
  }
}

async function openMockedChat(page: Page): Promise<void> {
  await installMockGateway(page, {
    historyMessages: Array.from({ length: 10 }, (_value, index) => ({
      content: [
        {
          type: "text",
          text: `Turn ${index}: review transcript text designed to wrap when the navigation changes.`,
        },
      ],
      role: index % 2 === 0 ? "user" : "assistant",
      timestamp: Date.now() - (10 - index) * 60_000,
    })),
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, SESSION_KEY));
  await waitForControlUiGatewayReady(page);
  await page.locator(".chat-thread").waitFor();
  await page.locator(".shell").evaluate(async (shell) => {
    const animations = shell
      .getAnimations({ subtree: true })
      .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.allSettled(animations.map((animation) => animation.finished));
  });
}

suite.define(() => {
  it("stages the dock conversation one frame behind the panel frame", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await openMockedChat(page);
        await page.evaluate(() => {
          const frames: Array<{ conversation: boolean; pane: boolean; staged: boolean | null }> =
            [];
          window.openclawDockStageFrames = frames;
          const sample = () => {
            const pane = document.querySelector<HTMLElement>(
              "openclaw-assistant-panel openclaw-chat-pane",
            );
            frames.push({
              conversation: Boolean(pane?.querySelector(".chat-thread")),
              pane: pane !== null,
              staged: pane
                ? ((pane as HTMLElement & { stagedConversation?: boolean }).stagedConversation ??
                  null)
                : null,
            });
            window.openclawDockStageFrame = requestAnimationFrame(sample);
          };
          sample();
        });
        await openAssistantDock(page, {
          sessionKey: "agent:main:dock",
          agentId: "main",
          label: "Dock",
        });
        await page
          .locator("openclaw-assistant-panel openclaw-chat-pane .chat-thread")
          .waitFor({ timeout: 10_000 });
        const frames = await page.evaluate(() => {
          cancelAnimationFrame(window.openclawDockStageFrame!);
          return window.openclawDockStageFrames!;
        });
        // The dock pane is the only surface that stages its conversation.
        expect(frames.some((frame) => frame.staged === true)).toBe(true);
        expect(frames.every((frame) => frame.staged !== false)).toBe(true);
        // A committed pane frame without the conversation precedes the
        // conversation commit, so the two layouts never share one frame.
        const stagedFrame = frames.findIndex((frame) => frame.pane && !frame.conversation);
        const conversationFrame = frames.findIndex((frame) => frame.conversation);
        expect(stagedFrame).toBeGreaterThanOrEqual(0);
        expect(conversationFrame).toBeGreaterThan(stagedFrame);
      },
    );
  });

  it("keeps the second transcript out of a close or reversal window", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await openMockedChat(page);
        const panelWidth = () =>
          page.evaluate(
            () =>
              document
                .querySelector<HTMLElement>("openclaw-assistant-panel .assistant-panel")
                ?.getBoundingClientRect().width ?? 0,
          );
        // One in-page script per phase: the sampler and the owner calls share a
        // single task, so the close lands mid-transition instead of waiting for
        // Playwright's actionability checks.
        const runPhase = (kind: "close" | "reverse") =>
          page.evaluate(
            async ({ dockParams, kind: phase }) => {
              const app = document.querySelector("openclaw-app") as HTMLElement & {
                runtime: {
                  context: {
                    assistantDock: {
                      close(): void;
                      openSession(params: typeof dockParams, activation: object): void;
                    };
                  };
                };
              };
              const dock = app.runtime.context.assistantDock;
              type Frame = { content: boolean; session: boolean; width: number };
              const frames: Frame[] = [];
              const sample = () => {
                const panel = document.querySelector<HTMLElement>(
                  "openclaw-assistant-panel .assistant-panel",
                );
                frames.push({
                  content: Boolean(panel?.querySelector("openclaw-assistant-panel-content")),
                  session: Boolean(panel?.querySelector("openclaw-assistant-session")),
                  width: panel?.getBoundingClientRect().width ?? 0,
                });
              };
              const waitFrames = (count: number) =>
                new Promise<void>((resolve) => {
                  let remaining = count;
                  const step = () => {
                    sample();
                    remaining -= 1;
                    if (remaining <= 0) {
                      resolve();
                      return;
                    }
                    requestAnimationFrame(step);
                  };
                  requestAnimationFrame(step);
                });
              dock.openSession(dockParams, {});
              await waitFrames(2);
              const widthAtClose =
                document
                  .querySelector<HTMLElement>("openclaw-assistant-panel .assistant-panel")
                  ?.getBoundingClientRect().width ?? 0;
              dock.close();
              if (phase === "close") {
                await waitFrames(16);
                return { frames, widthAtClose };
              }
              await waitFrames(2);
              dock.openSession(dockParams, {});
              await waitFrames(24);
              return { frames, widthAtClose };
            },
            { dockParams: DOCK_PARAMS, kind },
          );
        const closeDock = () =>
          page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime: { context: { assistantDock: { close(): void } } };
            };
            app.runtime.context.assistantDock.close();
          });
        const settlePanelClosed = async () => {
          await expect.poll(panelWidth).toBe(0);
          await expect
            .poll(() =>
              page.locator("openclaw-assistant-panel openclaw-assistant-panel-content").count(),
            )
            .toBe(0);
        };

        // Warm one full mount so the content element is already defined; the
        // deferred (unmounted) conversation is what protects the window.
        await openAssistantDock(page, DOCK_PARAMS);
        await page.locator("openclaw-assistant-panel openclaw-assistant-session").waitFor();
        await closeDock();
        await settlePanelClosed();

        // Second open, closed while its opening transition is still running.
        const closePhase = await runPhase("close");
        await settlePanelClosed();
        // The close landed while the panel was still easing open.
        expect(closePhase.widthAtClose).toBeGreaterThan(1);
        const closeMoving = closePhase.frames.filter((frame) => frame.width > 1);
        expect(closeMoving.length).toBeGreaterThan(1);
        // The close window is still a motion window: nothing mounts in it.
        expect(closeMoving.every((frame) => !frame.content && !frame.session)).toBe(true);
        expect(closePhase.frames.at(-1)?.width).toBe(0);
        expect(closePhase.frames.at(-1)?.content).toBe(false);

        // Reversal: open, close mid-open, open again mid-close, then settle.
        const reversePhase = await runPhase("reverse");
        await page.locator("openclaw-assistant-panel openclaw-assistant-session").waitFor();
        const firstMounted = reversePhase.frames.findIndex((frame) => frame.session);
        expect(firstMounted).toBeGreaterThan(1);
        const reversalMotion = reversePhase.frames.slice(0, firstMounted);
        expect(reversalMotion.filter((frame) => frame.width > 1).length).toBeGreaterThan(1);
        expect(reversalMotion.every((frame) => !frame.content)).toBe(true);
        // The conversation only lands after the motion settles, then stays.
        expect(reversePhase.frames.at(-1)?.session).toBe(true);
      },
    );
  });
});
