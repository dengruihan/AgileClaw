// Control UI tests cover the continuous corner curvature contract.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeCornerShape = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

// Rewrite the property in feature queries and declarations alike: unsupported
// engines also ignore corner-shape outside an @supports block.
const UNSUPPORTED_PROPERTY = "openclaw-unsupported-corner-shape";

type Corners = {
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly topLeft: string;
  readonly topRight: string;
};

type CornerCase = {
  /** Corners an engine without corner-shape keeps drawing. */
  readonly circular: Corners;
  readonly markup: string;
  /** `pseudo` probes the generated box instead of the element itself. */
  readonly pseudo?: string;
  readonly selector: string;
  readonly shape: "superellipse" | "circular";
  /** Corners once the 1.25 compensation applies. */
  readonly superelliptical: Corners;
};

function corners(all: string, overrides: Partial<Corners> = {}): Corners {
  return { bottomLeft: all, bottomRight: all, topLeft: all, topRight: all, ...overrides };
}

// One row per contract category the corner owner in base.css covers. Selectors
// and markup mirror the real component DOM; expected values are the authored
// radius steps observed through computed style, not a copy of the source list.
const CASES: readonly CornerCase[] = [
  {
    // Canonical token surface; also the MCP/widget snapshot contract's consumer.
    circular: corners("14px"),
    markup: '<div class="card">Card</div>',
    selector: ".card",
    shape: "superellipse",
    superelliptical: corners("17.5px"),
  },
  {
    // A token surface no corner whitelist named: every page owns surfaces like
    // this, so the contract must not depend on listing them.
    circular: corners("14px"),
    markup: '<div class="activity-pulse">Pulse</div>',
    selector: ".activity-pulse",
    shape: "superellipse",
    superelliptical: corners("17.5px"),
  },
  {
    // Nested inside a rounded group: border-radius does not inherit, so a
    // container-scoped scale would leave this row behind.
    circular: corners("10px"),
    markup:
      '<section class="settings-group"><div class="settings-segmented">' +
      '<button type="button" class="settings-segmented__btn">A</button></div></section>',
    selector: ".settings-segmented",
    shape: "superellipse",
    superelliptical: corners("12.5px"),
  },
  {
    // Derived from the token on the matched element (panel step minus 3px), so
    // it must scale exactly once.
    circular: corners("7px"),
    markup: "",
    selector: ".settings-segmented__btn",
    shape: "superellipse",
    superelliptical: corners("9.5px"),
  },
  {
    // Asymmetric radius: only the rounded side curves; the square side stays.
    circular: corners("0px", { bottomLeft: "10px", topLeft: "10px" }),
    markup: '<div class="oc-sensitive-input"><input type="text" /></div>',
    selector: ".oc-sensitive-input > input",
    shape: "superellipse",
    superelliptical: corners("0px", { bottomLeft: "12.5px", topLeft: "12.5px" }),
  },
  {
    // Author-tuned pixel radius below the token ladder: it gains the curvature
    // but keeps its authored value (the contract does not rescale raw pixels).
    circular: corners("12px"),
    markup: '<div class="plugin-editor__group">Group</div>',
    selector: ".plugin-editor__group",
    shape: "superellipse",
    superelliptical: corners("12px"),
  },
  {
    // The shaped design gives this card the larger step; engines without
    // corner-shape keep the pre-change main rule's plain radius.
    circular: corners("10px"),
    markup: '<div class="code-block-wrapper"><pre><code>x</code></pre></div>',
    selector: ".code-block-wrapper",
    shape: "superellipse",
    superelliptical: corners("17.5px"),
  },
  {
    // Pre-change main fallback: the attachment card used the control step.
    circular: corners("10px"),
    markup: '<div class="chat-assistant-attachment-card">Attachment</div>',
    selector: ".chat-assistant-attachment-card",
    shape: "superellipse",
    superelliptical: corners("17.5px"),
  },
  {
    // Pre-change main fallback: the user bubble inherited the base thread step.
    circular: corners("10px"),
    markup: '<div class="chat-group user"><div class="chat-bubble">Hello</div></div>',
    selector: ".chat-group.user .chat-bubble",
    shape: "superellipse",
    superelliptical: corners("17.5px"),
  },
  {
    // Pre-change main fallback: the image caption used the base thread step.
    circular: corners("10px"),
    markup:
      '<div class="chat-group user"><div class="chat-bubble chat-bubble--with-images">' +
      '<div class="chat-message-avatar-anchor"><div class="chat-text">Caption</div></div>' +
      "</div></div>",
    selector: ".chat-text",
    shape: "superellipse",
    superelliptical: corners("17.5px"),
  },
  {
    // Pre-change main fallback: the nested preview used the card step.
    circular: corners("14px"),
    markup: '<div class="chat-tool-card__preview">Preview</div>',
    selector: ".chat-tool-card__preview",
    shape: "superellipse",
    superelliptical: corners("12.5px"),
  },
  {
    // The pre-change main rule gave this row no radius at all.
    circular: corners("0px"),
    markup: '<div class="sidebar-recent-session">Session</div>',
    selector: ".sidebar-recent-session",
    shape: "superellipse",
    superelliptical: corners("12.5px"),
  },
  {
    // The shared neighbor-card rule owns this step; the contract scales it via
    // the one scale signal without a second radius declaration.
    circular: corners("16px"),
    markup: '<div class="chat-pr">PR</div>',
    selector: ".chat-pr",
    shape: "superellipse",
    superelliptical: corners("20px"),
  },
  {
    // Generated box with a deliberately asymmetric corner: the universal rule
    // reaches ::before/::after, not only elements.
    circular: corners("0px", { topRight: "17px" }),
    markup: '<div class="approval-page__card">Approval</div>',
    pseudo: "::after",
    selector: ".approval-page__card",
    shape: "superellipse",
    superelliptical: corners("0px", { topRight: "17px" }),
  },
  {
    // Fully rounded chrome stays a true arc: a superellipse would flatten the
    // pill, status dot and avatar silhouettes.
    circular: corners("9999px"),
    markup: '<span class="pill">Pill</span>',
    selector: ".pill",
    shape: "circular",
    superelliptical: corners("9999px"),
  },
  {
    circular: corners("9999px"),
    markup: '<span class="chip">Chip</span>',
    selector: ".chip",
    shape: "circular",
    superelliptical: corners("9999px"),
  },
  {
    circular: corners("9999px"),
    markup: '<span class="statusDot"></span>',
    selector: ".statusDot",
    shape: "circular",
    superelliptical: corners("9999px"),
  },
  {
    circular: corners("9999px"),
    markup: '<span class="activity-feed__presence-dot"></span>',
    selector: ".activity-feed__presence-dot",
    shape: "circular",
    superelliptical: corners("9999px"),
  },
  {
    circular: corners("50%"),
    markup:
      '<span class="chat-author-avatar"><img class="chat-author-avatar__image" alt="" /></span>',
    selector: ".chat-author-avatar",
    shape: "circular",
    superelliptical: corners("50%"),
  },
  {
    // The child inherits the radius, and the exception inherits with it, so the
    // image cannot turn into a squircle inside a circular avatar.
    circular: corners("50%"),
    markup: "",
    selector: ".chat-author-avatar__image",
    shape: "circular",
    superelliptical: corners("50%"),
  },
  {
    // Production status dot from renderSessionColorDot(): an 8x8 full-round
    // marker that must stay a true circle, not a squircle.
    circular: corners("9999px"),
    markup:
      '<span class="session-color-dot" role="img" aria-label="Blue" ' +
      'style="--session-color: var(--session-color-blue)"></span>',
    selector: ".session-color-dot",
    shape: "circular",
    superelliptical: corners("9999px"),
  },
  {
    // A zero radius draws no corner, so the state stays square even though the
    // element itself is matched by the universal rule.
    circular: corners("0px"),
    markup:
      '<div class="sidebar-recent-session"><a class="sidebar-recent-session__link" href="#s">Session</a></div>',
    selector: ".sidebar-recent-session__link",
    shape: "superellipse",
    superelliptical: corners("0px"),
  },
  {
    // The full-round control stays circular, while an ordinary menu row nested
    // inside it must keep the continuous curvature (no inherited exception).
    circular: corners("9999px"),
    markup:
      '<div class="agent-chat__input"><span class="chat-talk-control">' +
      '<wa-dropdown class="chat-talk-input-picker">' +
      '<wa-dropdown-item class="chat-talk-input-picker__item">Voice</wa-dropdown-item>' +
      "</wa-dropdown></span></div>",
    selector: ".chat-talk-control",
    shape: "circular",
    superelliptical: corners("9999px"),
  },
  {
    circular: corners("10px"),
    markup: "",
    selector: ".chat-talk-input-picker__item",
    shape: "superellipse",
    superelliptical: corners("12.5px"),
  },
  {
    // Inline-styled avatars carry their own radius and the shared circular
    // exception class, exactly like the Nostr profile pictures.
    circular: corners("50%"),
    markup:
      '<img class="nostr-profile-picture" alt="" ' +
      'style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover" />',
    selector: ".nostr-profile-picture",
    shape: "circular",
    superelliptical: corners("50%"),
  },
];

const READ_STYLESHEETS = [
  "ui/src/styles/base.css",
  "ui/src/styles/continuous-corners.css",
  "ui/src/styles/components.css",
  "ui/src/styles/layout.css",
  "ui/src/styles/app-sidebar.css",
  "ui/src/styles/activity.css",
  "ui/src/styles/approval.css",
  "ui/src/styles/option-card.css",
  "ui/src/styles/settings.css",
  "ui/src/styles/settings-controls.css",
  "ui/src/styles/channels.css",
  "ui/src/styles/chat/startup-layout.css",
  "ui/src/styles/chat/layout.css",
  "ui/src/styles/chat/message-layout.css",
  "ui/src/styles/chat/grouped.css",
  "ui/src/styles/chat/tool-cards.css",
  "ui/src/styles/chat/composer-surface.css",
  "ui/src/styles/chat/composer.css",
  "ui/src/pages/plugins/settings-editor.css",
];

// CSSOM can serialize the same circular shape as round or superellipse(1).
// https://drafts.csswg.org/css-borders-4/#valdef-corner-shape-value-round
const CIRCULAR_SHAPE = expect.stringMatching(/^(?:round|superellipse\(1\))$/);

// The canonical tokens, read at :root exactly like collectMcpAppStyleVariables()
// and buildWidgetThemeMessage() read them for embedded documents. A separate
// origin only ever sees this snapshot, so the compensation must stay scoped to
// the app (`body`), never to the token definitions themselves.
const ROOT_RADIUS_TOKENS = {
  "--radius": "10px",
  "--radius-full": "9999px",
  "--radius-lg": "14px",
  "--radius-md": "10px",
  "--radius-sm": "6px",
  "--radius-xl": "20px",
} as const;

// What the app itself consumes under the compensation, including the alias
// families that resolve where they are declared (`:root`) and are therefore
// restated at the app scope.
const APP_RADIUS_TOKENS = {
  "--menu-item-radius": "8.5px",
  "--menu-radius": "12.5px",
  "--oc-radius-control": "12.5px",
  "--radius": "12.5px",
  "--radius-full": "9999px",
  "--radius-lg": "17.5px",
  "--radius-md": "12.5px",
  "--radius-sm": "7.5px",
  "--radius-xl": "25px",
  "--wa-border-radius-l": "15px",
  "--wa-border-radius-m": "7.5px",
  "--wa-border-radius-s": "3.75px",
} as const;

function readUiCss(): string {
  return READ_STYLESHEETS.map((file) => readStyleSheet(file)).join("\n");
}

const FIXTURE_MARKUP = CASES.map((corner) => corner.markup).join("\n");

function fixtureDocument(css: string): string {
  return `<!doctype html><html data-theme-mode="light"><head><style>${css}</style></head><body>
    <main>${FIXTURE_MARKUP}</main>
  </body></html>`;
}

type CornerProbe = Record<
  string,
  { bottomLeft: string; bottomRight: string; shape: string; topLeft: string; topRight: string }
>;

async function probeCorners(browser: Browser, fixtureFile: string): Promise<CornerProbe> {
  const page = await browser.newPage();
  try {
    await page.goto(`file://${fixtureFile}`);
    return await page.evaluate(
      (probes: readonly { pseudo?: string; selector: string }[]) => {
        return Object.fromEntries(
          probes.map(({ pseudo, selector }) => {
            const element = document.querySelector(selector);
            if (!element) {
              throw new Error(`Missing corner fixture element for ${selector}`);
            }
            const style = getComputedStyle(element, pseudo);
            return [
              selector + (pseudo ?? ""),
              {
                bottomLeft: style.borderBottomLeftRadius,
                bottomRight: style.borderBottomRightRadius,
                shape: style.getPropertyValue("corner-shape"),
                topLeft: style.borderTopLeftRadius,
                topRight: style.borderTopRightRadius,
              },
            ];
          }),
        );
      },
      CASES.map(({ pseudo, selector }) => ({ pseudo, selector })),
    );
  } finally {
    await page.close().catch(() => {});
  }
}

async function probeRootRadiusTokens(
  browser: Browser,
  fixtureFile: string,
): Promise<Record<string, string>> {
  const page = await browser.newPage();
  try {
    await page.goto(`file://${fixtureFile}`);
    return await page.evaluate((tokens: readonly string[]) => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(
        tokens.map((token) => [token, style.getPropertyValue(token).trim()]),
      );
    }, Object.keys(ROOT_RADIUS_TOKENS));
  } finally {
    await page.close().catch(() => {});
  }
}

async function probeRadiusTokenValues(
  browser: Browser,
  fixtureFile: string,
  tokens: readonly string[],
): Promise<Record<string, string>> {
  const page = await browser.newPage();
  try {
    await page.goto(`file://${fixtureFile}`);
    return await page.evaluate((names: readonly string[]) => {
      // Read the token through its only real consumer shape: a corner. Custom
      // properties keep their calc() token stream, so serializing the property
      // itself would assert source text instead of the drawn radius.
      return Object.fromEntries(
        names.map((token) => {
          const probe = document.createElement("div");
          probe.style.borderTopLeftRadius = `var(${token})`;
          document.body.append(probe);
          const value = getComputedStyle(probe).borderTopLeftRadius;
          probe.remove();
          return [token, value];
        }),
      );
    }, tokens);
  } finally {
    await page.close().catch(() => {});
  }
}

const canRun = canRunPlaywrightChromium(chromiumExecutablePath);

let fixtureDirectory: string;
let superellipticalFixture: string;
let circularFixture: string;
let browser: Browser;
let css = "";

beforeAll(async () => {
  if (!canRun) {
    return;
  }
  css = readUiCss();
  browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
});

beforeEach(() => {
  if (!canRun) {
    return;
  }
  fixtureDirectory = tempDirs.make("corner-shape-");
  superellipticalFixture = path.join(fixtureDirectory, "superelliptical.html");
  circularFixture = path.join(fixtureDirectory, "circular.html");
  fs.writeFileSync(superellipticalFixture, fixtureDocument(css), "utf8");
  fs.writeFileSync(
    circularFixture,
    fixtureDocument(css.replaceAll("corner-shape:", `${UNSUPPORTED_PROPERTY}:`)),
    "utf8",
  );
});

afterAll(async () => {
  await browser?.close().catch(() => {});
});

describeCornerShape("Control UI corner curvature", () => {
  it("draws the superellipse on every rounded surface family", async () => {
    const probe = await probeCorners(browser, superellipticalFixture);
    const expected: CornerProbe = {};
    for (const corner of CASES) {
      const key = corner.selector + (corner.pseudo ?? "");
      expected[key] = {
        ...corner.superelliptical,
        shape: corner.shape === "superellipse" ? "superellipse(1.5)" : CIRCULAR_SHAPE,
      };
    }
    expect(probe).toEqual(expected);
  });

  it("keeps today's corners on engines without corner-shape", async () => {
    const probe = await probeCorners(browser, circularFixture);
    const expected: CornerProbe = {};
    for (const corner of CASES) {
      const key = corner.selector + (corner.pseudo ?? "");
      expected[key] = {
        ...corner.circular,
        // A disabled corner-shape declaration leaves the initial circular shape.
        shape: CIRCULAR_SHAPE,
      };
    }
    expect(probe).toEqual(expected);
  });

  it("keeps the canonical token snapshot and compensates only the app scope", async () => {
    // :root is the snapshot embedded MCP apps and widget iframes read, so it
    // keeps the canonical literal values.
    expect(await probeRootRadiusTokens(browser, superellipticalFixture)).toEqual(
      ROOT_RADIUS_TOKENS,
    );
    // The app consumes the compensated chain, including the alias families that
    // resolve at :root.
    expect(
      await probeRadiusTokenValues(browser, superellipticalFixture, Object.keys(APP_RADIUS_TOKENS)),
    ).toEqual(APP_RADIUS_TOKENS);
    expect(
      await probeRadiusTokenValues(browser, circularFixture, [
        "--menu-item-radius",
        "--menu-radius",
        "--radius-lg",
        "--radius-md",
        "--radius-sm",
        "--radius-xl",
      ]),
    ).toEqual({
      "--menu-item-radius": "6px",
      "--menu-radius": "10px",
      "--radius-lg": "14px",
      "--radius-md": "10px",
      "--radius-sm": "6px",
      "--radius-xl": "20px",
    });
  });
});
