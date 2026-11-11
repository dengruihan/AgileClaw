// Shared fixture and physics probes for the skeuomorphic key suites: the real
// stylesheet cascade, the fixture document both suites render, and the computed
// style readers they assert on. Both the controls suite and the hover-contract
// suite own their own scenarios; only the fixture and readers live here.
import type { Locator, Page } from "playwright";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";

export function readUiCss(): string {
  return [
    "ui/src/styles/base.css",
    "ui/src/styles/layout.css",
    "ui/src/styles/components.css",
    "ui/src/styles/settings-controls.css",
    // The session-row system is owned by the lazy sidebar component; its sheet
    // loads after the core bundle, then the roster's own reset sheet.
    "ui/src/styles/app-sidebar.css",
    "ui/src/styles/sidebar-agent-roster.css",
    // The option card is a lazy component-owned sheet, like a page import.
    "ui/src/styles/option-card.css",
  ]
    .map((file) => readStyleSheet(file))
    .join("\n");
}

export type KeyPhysics = {
  transform: string;
  shadow: string;
  glossPosition: string;
  backgroundImage: string;
  transformDuration: string;
  transformTiming: string;
};

export function readKeyPhysics(locator: Locator): Promise<KeyPhysics> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const properties = style.transitionProperty.split(",").map((value) => value.trim());
    // A single computed duration/timing repeats across every property.
    const durations = style.transitionDuration.split(",").map((value) => value.trim());
    const timings = style.transitionTimingFunction.match(/cubic-bezier\([^)]+\)|[a-z-]+/gu) ?? [];
    const transformIndex = properties.indexOf("transform");
    const duration = durations.length === 1 ? durations[0] : durations[transformIndex];
    const timing = timings.length === 1 ? timings[0] : timings[transformIndex];
    return {
      transform: style.transform,
      shadow: style.boxShadow,
      glossPosition: style.backgroundPosition,
      backgroundImage: style.backgroundImage,
      transformDuration: duration ?? "none",
      transformTiming: timing ?? "none",
    } satisfies KeyPhysics;
  });
}

export function transformY(transform: string): number {
  const match = /matrix\([^,]+, [^,]+, [^,]+, [^,]+, [^,]+, ([^)]+)\)/u.exec(transform);
  return match?.[1] ? Number.parseFloat(match[1]) : Number.NaN;
}

export const settleFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

export function fixtureDocument(theme: "dark" | "light"): string {
  return `<!doctype html><html data-theme="${theme === "light" ? "phosphor-light" : "phosphor"}" data-theme-mode="${theme}"><head><style>${readUiCss()}</style></head>
  <body><main style="padding: 24px; display: grid; gap: 20px; width: 420px">
    <button class="btn" type="button" id="key-neutral">Deploy agent</button>
    <button class="btn" type="button" id="key-disabled" disabled>Unavailable</button>
    <button class="btn btn--icon" type="button" id="key-icon" aria-label="Refresh"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg></button>
    <button class="btn btn--icon active" type="button" id="key-icon-latched" aria-label="Pinned"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/></svg></button>
    <button class="btn btn--icon" type="button" id="key-icon-disabled" disabled aria-label="Locked"><svg viewBox="0 0 24 24" width="18" height="18"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></button>
    <button class="btn btn--icon btn--ghost" type="button" id="key-icon-ghost" aria-label="More"><svg viewBox="0 0 24 24" width="18" height="18"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>
    <label class="field"><span>Name</span><input type="text" id="well-input" value="phosphor" /></label>
    <label class="field checkbox"><input type="checkbox" id="latch" /><span>Auto-update</span></label>
    <label class="field checkbox"><input type="checkbox" id="latch-set" checked /><span>Telemetry</span></label>
    <label class="field checkbox"><input type="radio" id="dial" name="dial" checked /><span>Dark artwork</span></label>
    <label class="field"><span>Effort</span><input type="range" id="fader" min="0" max="100" value="45" /></label>
    <nav style="display: flex; flex-direction: column; gap: 2px; width: 220px" aria-label="Console rail keys">
      <a class="nav-item" href="#" id="rail-nav" onclick="return false"><span class="nav-item__icon"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /></svg></span><span class="nav-item__text">Sessions</span></a>
      <a class="nav-item active" href="#" id="rail-nav-selected" onclick="return false"><span class="nav-item__icon"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1" /></svg></span><span class="nav-item__text">Dashboards</span></a>
    </nav>
    <button class="sidebar-brand__icon" type="button" id="rail-collapse" aria-label="Collapse sidebar"><svg viewBox="0 0 24 24" width="16" height="16"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M10 3v18" /></svg></button>
    <button class="sidebar-issues-button" type="button" id="rail-inbox" aria-expanded="false" aria-label="Inbox"><span class="sidebar-issues-button__icon"><svg viewBox="0 0 24 24" width="18" height="18"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5 4h14l3 8v10H2V12l3-8z" /></svg></span><span class="sidebar-issues-button__count">3</span></button>
    <button class="sidebar-identity-card" type="button" id="rail-identity" aria-expanded="false"><span class="viewer-avatar viewer-avatar--footer"><span>R</span></span><span class="sidebar-identity-card__text"><span class="sidebar-identity-card__name">Riley</span></span></button>
    <section class="sidebar-sessions" id="rail-sessions" style="width: 260px">
      <div class="sidebar-recent-sessions">
        <div class="sidebar-recent-sessions__list">
    <div class="sidebar-recent-session session-row-host" id="rail-session" style="position: relative">
      <a href="#" class="sidebar-recent-session__link" id="rail-session-link" onclick="return false"><span class="sidebar-session-indicator"><span class="session-color-dot" style="--session-color: var(--session-color-blue)"></span></span><span class="sidebar-recent-session__text"><span class="sidebar-recent-session__title-row"><span class="sidebar-recent-session__name">Release prep</span></span></span></a>
      <span class="sidebar-recent-session__aside session-row-aside"><span class="session-row-actions"><button class="session-action" type="button" id="rail-session-action" aria-label="Archive"><svg viewBox="0 0 24 24" width="14" height="14"><rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /></svg></button></span></span>
    </div>
    <div class="sidebar-recent-session sidebar-recent-session--active session-row-host" id="rail-session-current" style="position: relative">
      <a href="#" class="sidebar-recent-session__link" aria-current="page" onclick="return false"><span class="sidebar-session-indicator"><span class="session-color-dot" style="--session-color: var(--session-color-green)"></span></span><span class="sidebar-recent-session__text"><span class="sidebar-recent-session__title-row"><span class="sidebar-recent-session__name">Molty</span></span></span></a>
    </div>
    <div class="sidebar-recent-session sidebar-recent-session--selected session-row-host" id="rail-session-selected" style="position: relative">
      <a href="#" class="sidebar-recent-session__link" onclick="return false"><span class="sidebar-session-indicator"></span><span class="sidebar-recent-session__text"><span class="sidebar-recent-session__title-row"><span class="sidebar-recent-session__name">Family</span></span></span></a>
    </div>
    <div class="sidebar-recent-session session-row-host" id="rail-session-parent" style="position: relative">
      <a href="#" class="sidebar-recent-session__link" onclick="return false"><span class="sidebar-session-indicator"></span><span class="sidebar-recent-session__text"><span class="sidebar-recent-session__title-row"><span class="sidebar-recent-session__name">Tax filing research</span></span></span></a>
      <button class="sidebar-child-session-toggle" id="rail-disclosure-expanded" type="button" aria-expanded="true" aria-label="Hide child sessions"><span class="sidebar-child-session-toggle__icon"><svg viewBox="0 0 24 24" width="11" height="11"><path d="m6 9 6 6 6-6" /></svg></span></button>
    </div>
    <div class="sidebar-session-tree" id="rail-session-tree" style="position: relative">
      <div class="sidebar-recent-session session-row-host" style="position: relative">
        <a href="#" class="sidebar-recent-session__link" onclick="return false"><span class="sidebar-session-indicator"></span><span class="sidebar-recent-session__text"><span class="sidebar-recent-session__title-row"><span class="sidebar-recent-session__name">Tax filing research</span></span></span></a>
      </div>
      <div class="sidebar-session-tree__children">
        <div class="sidebar-session-tree__list">
          <div class="sidebar-session-tree">
            <div class="sidebar-recent-session sidebar-recent-session--child session-row-host" style="position: relative">
              <a href="#" class="sidebar-recent-session__link" onclick="return false"><span class="sidebar-session-indicator"></span><span class="sidebar-recent-session__text"><span class="sidebar-recent-session__title-row"><span class="sidebar-recent-session__name">Reading receipts</span></span></span></a>
            </div>
          </div>
          <div class="sidebar-session-tree">
            <div class="sidebar-recent-session sidebar-recent-session--child session-row-host" style="position: relative">
              <a href="#" class="sidebar-recent-session__link" onclick="return false"><span class="sidebar-session-indicator"></span><span class="sidebar-recent-session__text"><span class="sidebar-recent-session__title-row"><span class="sidebar-recent-session__name">Filing corrections</span></span></span></a>
            </div>
          </div>
        </div>
      </div>
    </div>
        </div>
      </div>
    </section>
    <a class="sidebar-new-session-action" href="#" id="reference-new-session" onclick="return false"><span>New session</span></a><button class="btn primary" type="button" id="key-primary">Open chat</button><section class="option-card" role="group" aria-label="Delivery lane"><div class="option-card__choices" role="radiogroup"><button class="option-card__choice" type="button" id="choice-plain"><span class="option-card__choice-copy"><strong>Fast lane</strong></span></button><button class="option-card__choice option-card__choice--recommended option-card__choice--selected" type="button" id="choice-selected"><span class="option-card__choice-copy"><strong>Careful lane</strong></span></button></div></section>
    <span id="accent-foreground-probe" aria-hidden="true" style="position: absolute; color: var(--accent-foreground)"></span>
  </main></body></html>`;
}
