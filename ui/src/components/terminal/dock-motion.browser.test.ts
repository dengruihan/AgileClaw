// Real-Chromium owner proof for the localized right-dock motion clock and the
// bounded motion start/end notification contract. The full-app geometry and
// reversal flows live in the shell-coupled-motion E2E suite; this file owns
// the module-level contract that E2E cannot reach (the subscription API) and
// exercises the real controller + real panel/shell CSS with live transitions.
import { type CSSResult, html, LitElement, nothing } from "lit";
import { afterEach, beforeEach, expect, it } from "vitest";
import "../../test-helpers/load-styles.ts";
import { browserPanelStyles } from "../browser/browser-panel.styles.ts";
import { DockLayoutController } from "../dock-layout-controller.ts";
import { createDockPanelLayout } from "../dock-panel-layout.ts";
import { dockPanelStyles } from "../dock-panel-styles.ts";
import { type RightDockMotionEvent, subscribeRightDockMotion } from "../right-dock-motion.ts";
import { terminalPanelStyles } from "./terminal-panel-styles.ts";

const EASE_OUT = "cubic-bezier(0, 0, 0.2, 1)";
const TERMINAL_WIDTH = 520;

class MotionTestDock extends LitElement {
  readonly dockLayout: DockLayoutController<"bottom" | "right">;
  protected panelClass = "tp";

  constructor(prefix: string, storageKey: string, minWidth: number, defaultWidth: number) {
    super();
    this.dockLayout = new DockLayoutController(this, {
      layout: createDockPanelLayout({
        storageKey,
        minHeight: 140,
        minWidth,
        defaultDock: "right",
        supportedDocks: ["bottom", "right"],
        defaultHeight: 320,
        defaultWidth,
      }),
      reservationPrefix: prefix,
      isAvailable: () => true,
      panelElement: () => this.renderRoot.querySelector(`.${this.panelClass}`),
    });
  }

  override render() {
    const layout = this.dockLayout;
    if (!layout.renderVisible) {
      return nothing;
    }
    return html`<section
      class="${this.panelClass} ${this.panelClass}--right ${layout.motionClassName}"
      style=${layout.panelStyle("right", layout.height, layout.width)}
    >
      <div class="dock-panel-content"></div>
    </section>`;
  }
}

class TerminalMotionDock extends MotionTestDock {
  static override styles: CSSResult[] = [dockPanelStyles, terminalPanelStyles];
  constructor() {
    super("terminal", "test.motion.terminal", 320, TERMINAL_WIDTH);
  }
}

class BrowserMotionDock extends MotionTestDock {
  static override styles: CSSResult[] = [dockPanelStyles, browserPanelStyles];
  protected override panelClass = "bp";
  constructor() {
    super("browser", "test.motion.browser", 380, 560);
  }
}

if (!customElements.get("motion-test-terminal")) {
  customElements.define("motion-test-terminal", TerminalMotionDock);
}
if (!customElements.get("motion-test-browser")) {
  customElements.define("motion-test-browser", BrowserMotionDock);
}

let shell: HTMLElement;
let events: RightDockMotionEvent[];
let unsubscribe: () => void;

beforeEach(() => {
  localStorage.clear();
  shell = document.createElement("div");
  shell.className = "shell";
  document.body.append(shell);
  events = [];
  unsubscribe = subscribeRightDockMotion((event) => events.push(event));
});

afterEach(() => {
  unsubscribe();
  // Disconnecting the hosts cancels any live motion through the real
  // lifecycle; the ready class is a page-lifetime singleton and stays.
  document.body.replaceChildren();
  document.documentElement.removeAttribute("style");
  localStorage.clear();
});

function panelOf(dock: MotionTestDock): HTMLElement | null {
  return dock.renderRoot.querySelector(".tp, .bp");
}

function runningTransition(dock: MotionTestDock, property: string): CSSTransition | undefined {
  return panelOf(dock)
    ?.getAnimations()
    .find(
      (animation): animation is CSSTransition =>
        animation instanceof CSSTransition &&
        animation.transitionProperty === property &&
        animation.playState === "running",
    );
}

async function mount(dock: MotionTestDock): Promise<void> {
  document.body.append(dock);
  await dock.updateComplete;
  await expect
    .poll(() => document.documentElement.classList.contains("dock-motion-ready"))
    .toBe(true);
}

function eventsFor(prefix: string) {
  return events.filter((event) => event.prefix === prefix);
}

it("eases panel width and shell margin on one local 200ms ease-out clock", async () => {
  const dock = new TerminalMotionDock();
  await mount(dock);
  // The store clamps the default width to the (narrow) test viewport.
  const target = dock.dockLayout.width;
  dock.dockLayout.setOpen(true);
  await expect.poll(() => Boolean(runningTransition(dock, "width"))).toBe(true);

  // Start times resolve at the first rendering update after creation.
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
  const panel = panelOf(dock)!;
  const widthAnimation = runningTransition(dock, "width")!;
  const opacityAnimation = runningTransition(dock, "opacity");
  const marginAnimation = shell
    .getAnimations()
    .find(
      (animation): animation is CSSTransition =>
        animation instanceof CSSTransition && animation.transitionProperty === "margin-right",
    );
  expect(marginAnimation).toBeTruthy();
  const widthTiming = widthAnimation.effect!.getTiming();
  const marginTiming = marginAnimation!.effect!.getTiming();
  expect(widthTiming.duration).toBe(200);
  expect(widthTiming.easing).toBe(EASE_OUT);
  expect(marginTiming.duration).toBe(200);
  expect(marginTiming.easing).toBe(EASE_OUT);
  // One shared start frame: the local panel and plate clocks are synchronized
  // by construction, not by a per-frame JS driver.
  expect(widthAnimation.startTime).not.toBeNull();
  expect(marginAnimation!.startTime).not.toBeNull();
  expect(widthAnimation.startTime).toBe(marginAnimation!.startTime);

  for (const animation of [widthAnimation, marginAnimation!, opacityAnimation]) {
    if (animation) {
      animation.pause();
      animation.currentTime = 100;
    }
  }
  const midWidth = panel.getBoundingClientRect().width;
  expect(midWidth).toBeGreaterThan(1);
  expect(midWidth).toBeLessThan(target - 1);
  expect(Number.parseFloat(getComputedStyle(shell).marginRight)).toBeCloseTo(midWidth + 8, 0);
  // Content stays pinned at the target width while the frame eases.
  expect(panel.querySelector(".dock-panel-content")!.getBoundingClientRect().width).toBeCloseTo(
    target,
    0,
  );
  expect(panel.style.getPropertyValue("--oc-dock-content-width")).toBe(`${target}px`);

  widthAnimation.finish();
  marginAnimation!.finish();
  opacityAnimation?.finish();
  await expect.poll(() => panel.style.getPropertyValue("--oc-dock-content-width")).toBe("");
  await expect.poll(() => panel.getBoundingClientRect().width).toBeCloseTo(target, 0);
  expect(dock.dockLayout.motionClassName).toBe("");
  expect(eventsFor("terminal")).toEqual([
    { prefix: "terminal", phase: "start", direction: "opening" },
    { prefix: "terminal", phase: "end" },
  ]);
});

it("emits bounded start/end events across reversals, concurrent docks, and unmount", async () => {
  const terminal = new TerminalMotionDock();
  await mount(terminal);
  terminal.dockLayout.setOpen(true);
  await expect.poll(() => Boolean(runningTransition(terminal, "width"))).toBe(true);

  // Fast reversal while in flight: the motion stays active (no duplicate
  // start) and continues from the drawn geometry instead of snapping.
  terminal.dockLayout.setOpen(false);
  terminal.dockLayout.setOpen(true);
  await terminal.updateComplete;
  expect(eventsFor("terminal")).toEqual([
    { prefix: "terminal", phase: "start", direction: "opening" },
  ]);
  await expect
    .poll(() => {
      const width = panelOf(terminal)?.getBoundingClientRect().width ?? 0;
      return width > 1 && width < terminal.dockLayout.width - 1;
    })
    .toBe(true);

  // A concurrent sibling dock emits its own independent lifecycle.
  const browser = new BrowserMotionDock();
  await mount(browser);
  browser.dockLayout.setOpen(true);
  await expect.poll(() => eventsFor("browser").length).toBe(1);
  expect(events.filter((event) => event.phase === "start")).toHaveLength(2);

  await expect.poll(() => events.filter((event) => event.phase === "end").length).toBe(2);
  expect(eventsFor("terminal")).toEqual([
    { prefix: "terminal", phase: "start", direction: "opening" },
    { prefix: "terminal", phase: "end" },
  ]);
  expect(eventsFor("browser")).toEqual([
    { prefix: "browser", phase: "start", direction: "opening" },
    { prefix: "browser", phase: "end" },
  ]);

  // Unmount mid-close settles through the real cancel path: one more bounded
  // start/end pair, never per-frame events.
  browser.dockLayout.setOpen(false);
  await expect.poll(() => Boolean(runningTransition(browser, "width"))).toBe(true);
  browser.remove();
  await expect.poll(() => eventsFor("browser").length).toBe(4);
  expect(eventsFor("browser")).toEqual([
    { prefix: "browser", phase: "start", direction: "opening" },
    { prefix: "browser", phase: "end" },
    { prefix: "browser", phase: "start", direction: "closing" },
    { prefix: "browser", phase: "end" },
  ]);
  expect(eventsFor("terminal")).toHaveLength(2);
});

it("snaps without motion events for instant toggles and boot restore", async () => {
  const dock = new TerminalMotionDock();
  await mount(dock);
  dock.dockLayout.setOpen(true, false, { instant: true });
  await dock.updateComplete;
  expect(panelOf(dock)!.getBoundingClientRect().width).toBe(dock.dockLayout.width);
  dock.dockLayout.setOpen(false, false, { instant: true });
  await dock.updateComplete;
  expect(panelOf(dock)).toBeNull();
  expect(events).toEqual([]);
  dock.remove();

  // A persisted open dock restores on boot without animating or notifying.
  localStorage.setItem(
    "test.motion.terminal",
    JSON.stringify({ open: true, dock: "right", height: 320, width: TERMINAL_WIDTH }),
  );
  const restored = new TerminalMotionDock();
  await mount(restored);
  expect(panelOf(restored)!.getBoundingClientRect().width).toBe(restored.dockLayout.width);
  expect(events).toEqual([]);
});

/** Records whether the shared inherited-clock freeze ever ran during `run`. */
async function withRetargetWatch<T>(
  run: () => Promise<T>,
): Promise<{ result: T; frozen: boolean }> {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((entries) => records.push(...entries));
  observer.observe(document.documentElement, {
    attributeFilter: ["class"],
    attributeOldValue: true,
    attributes: true,
  });
  try {
    const result = await run();
    records.push(...observer.takeRecords());
    // The freeze adds and removes the class inside one task, so the removal
    // record's oldValue is the only synchronous trace of it.
    const frozen = records.some((record) => record.oldValue?.includes("dock-motion-retarget"));
    return {
      result,
      frozen: frozen || document.documentElement.classList.contains("dock-motion-retarget"),
    };
  } finally {
    observer.disconnect();
  }
}

function pauseDockMotionAt(docks: readonly MotionTestDock[], time: number): void {
  const animations = [
    ...docks.flatMap((dock) => panelOf(dock)?.getAnimations() ?? []),
    ...shell.getAnimations(),
  ].filter(
    (animation, index, all) =>
      animation instanceof CSSTransition &&
      (animation.transitionProperty === "width" ||
        animation.transitionProperty === "right" ||
        animation.transitionProperty === "margin-right") &&
      all.indexOf(animation) === index,
  );
  for (const animation of animations) {
    animation.pause();
    animation.currentTime = time;
  }
}

function drawnDockGeometry(docks: readonly MotionTestDock[]): {
  margin: number;
  rights: number[];
  widths: number[];
} {
  return {
    margin: Number.parseFloat(getComputedStyle(shell).marginRight),
    rights: docks.map((dock) => Number.parseFloat(getComputedStyle(panelOf(dock)!).right)),
    widths: docks.map((dock) => panelOf(dock)!.getBoundingClientRect().width),
  };
}

it("starts a fresh motion from the static targets without freezing the shared clock", async () => {
  const terminal = new TerminalMotionDock();
  await mount(terminal);
  const browser = new BrowserMotionDock();
  await mount(browser);
  // A settled sibling must not make the next fresh start look in-flight.
  terminal.dockLayout.setOpen(true);
  await expect.poll(() => eventsFor("terminal").length).toBe(2);
  browser.dockLayout.setOpen(true);
  await expect.poll(() => eventsFor("browser").length).toBe(2);
  browser.dockLayout.setOpen(false);
  await expect.poll(() => eventsFor("browser").length).toBe(4);

  const { frozen } = await withRetargetWatch(async () => {
    browser.dockLayout.setOpen(true);
    await expect.poll(() => Boolean(runningTransition(browser, "width"))).toBe(true);
    return browser;
  });
  // A fresh start has no drawn in-flight consumer: freezing the inherited clock
  // would restyle the whole tree for nothing.
  expect(frozen).toBe(false);

  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
  pauseDockMotionAt([terminal, browser], 100);
  const { margin, rights, widths } = drawnDockGeometry([terminal, browser]);
  expect(widths[0]).toBeGreaterThan(1);
  expect(widths[1]).toBeGreaterThan(1);
  // Sibling offset and plate margin are the same prefix sums the panels draw:
  // a fresh start keeps sum-of-panels and plate margin equal frame by frame.
  expect(rights[1]).toBeCloseTo(widths[0], 0);
  expect(margin).toBeCloseTo(widths[0] + widths[1] + 8, 0);
  expect(runningTransition(terminal, "width")).toBeUndefined();
});

it("keeps the joint freeze for reversals and concurrent docks", async () => {
  const terminal = new TerminalMotionDock();
  await mount(terminal);
  terminal.dockLayout.setOpen(true);
  await expect.poll(() => Boolean(runningTransition(terminal, "width"))).toBe(true);

  // Reversal and a concurrent sibling both retarget consumers that are still
  // drawing, so the joint freeze/restart must stay.
  const reversal = await withRetargetWatch(async () => {
    terminal.dockLayout.setOpen(false);
    terminal.dockLayout.setOpen(true);
    await expect.poll(() => eventsFor("terminal").length).toBe(1);
  });
  expect(reversal.frozen).toBe(true);

  const browser = new BrowserMotionDock();
  await mount(browser);
  const concurrent = await withRetargetWatch(async () => {
    browser.dockLayout.setOpen(true);
    await expect.poll(() => Boolean(runningTransition(browser, "width"))).toBe(true);
  });
  expect(concurrent.frozen).toBe(true);

  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
  pauseDockMotionAt([terminal, browser], 100);
  const { margin, widths } = drawnDockGeometry([terminal, browser]);
  // A sibling mounted mid-motion has no drawn offset to ease from; the plate
  // margin is still the sum of the drawn panels plus its inset.
  expect(margin).toBeCloseTo(widths[0] + widths[1] + 8, 0);
});

it("starts a local width transition when a settled dock closes", async () => {
  const dock = new TerminalMotionDock();
  await mount(dock);
  dock.dockLayout.setOpen(true);
  await expect.poll(() => Boolean(runningTransition(dock, "width"))).toBe(true);
  await new Promise<void>((resolve) => {
    for (const animation of panelOf(dock)?.getAnimations() ?? []) {
      animation.finish();
    }
    for (const animation of shell.getAnimations()) {
      animation.finish();
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  await expect
    .poll(() => panelOf(dock)?.getBoundingClientRect().width)
    .toBeCloseTo(dock.dockLayout.width, 0);

  dock.dockLayout.setOpen(false);
  await expect.poll(() => Boolean(runningTransition(dock, "width"))).toBe(true);
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
  const width = runningTransition(dock, "width");
  const margin = shell
    .getAnimations()
    .find(
      (animation): animation is CSSTransition =>
        animation instanceof CSSTransition && animation.transitionProperty === "margin-right",
    );
  expect(width, "closing width transition").toBeTruthy();
  expect(width?.startTime, "closing width start time").not.toBeNull();
  expect(margin?.startTime, "closing margin start time").not.toBeNull();
  expect(width?.startTime).toBe(margin?.startTime);
});
