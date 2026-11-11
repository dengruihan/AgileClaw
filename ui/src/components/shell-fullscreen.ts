import { html, type TemplateResult } from "lit";
import { isNativeEmbedHost } from "../app/native-web-chrome.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { FullscreenController } from "./fullscreen-controller.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";

/** Chat panes render outside the shell's template tree, so their header requests a toggle instead. */
export const SHELL_FULLSCREEN_TOGGLE_EVENT = "openclaw:shell-fullscreen-toggle";

export type ShellFullscreenToggleDetail = { trigger?: HTMLElement };

/** The whole Control UI page is the fullscreen target; docked panels keep their own surfaces. */
export function shellFullscreenElement(): HTMLElement {
  return document.documentElement;
}

export function shellFullscreenActive(): boolean {
  return document.fullscreenElement === shellFullscreenElement();
}

export function shellFullscreenSupported(): boolean {
  return document.fullscreenEnabled && typeof Element.prototype.requestFullscreen === "function";
}

/**
 * Ownership of F11 only makes sense while the browser can serve the Fullscreen
 * API. Otherwise the shortcut's native behavior is the only working path.
 */
function ownsFullscreenShortcut(event: KeyboardEvent): boolean {
  if (event.key !== "F11" || event.repeat || event.defaultPrevented) {
    return false;
  }
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }
  if (document.openClawModalLayers?.size) {
    return false;
  }
  // Native app embeds keep the host window's own fullscreen boundary.
  if (isNativeEmbedHost()) {
    return false;
  }
  // The remote desktop document forwards keystrokes to the remote machine, so
  // the remote OS owns this key while its keyboard input holds focus.
  if (
    event
      .composedPath()
      .some(
        (node) =>
          node instanceof HTMLTextAreaElement && node.classList.contains("desktop-keyboard-input"),
      )
  ) {
    return false;
  }
  return shellFullscreenSupported();
}

/** Innermost focus across shadow roots: the element to restore after external exit. */
function activeElementDeep(): HTMLElement | null {
  let active = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active instanceof HTMLElement ? active : null;
}

/**
 * Whole-document fullscreen for the shell. One instance owns the Fullscreen API
 * through the shared controller; toolbars render from the browser's state and
 * request a toggle instead of keeping their own copies.
 */
export class ShellFullscreen {
  private readonly controller: FullscreenController;

  constructor(host: OpenClawLitElement, onError: (message: string) => void) {
    this.controller = new FullscreenController(host, {
      section: shellFullscreenElement,
      onChange: () => host.requestUpdate(),
      onError,
      enterLabel: () => t("shell.enterFullscreen"),
      exitLabel: () => t("shell.exitFullscreen"),
      unavailableLabel: () => t("shell.fullscreenUnavailable"),
      errorMessage: (error: unknown) =>
        t("shell.fullscreenFailed", { error: formatUiError(error) }),
      buttonClass: "shell-fullscreen-button",
      buttonSelector: ".shell-fullscreen-button",
      iconClass: "shell-fullscreen-icon",
    });
  }

  get active(): boolean {
    return this.controller.active;
  }

  readonly toggle = (trigger: HTMLElement | null = null): void => {
    void this.controller.toggle(trigger);
  };

  /** Hands F11 to the document target, or leaves the browser's native shortcut alone. */
  handleShortcut(event: KeyboardEvent): boolean {
    if (!ownsFullscreenShortcut(event)) {
      return false;
    }
    // One state for the whole document: the browser's native window fullscreen
    // must not fire alongside the Fullscreen API request.
    event.preventDefault();
    this.toggle(activeElementDeep());
    return true;
  }
}

export function renderShellFullscreenButton(options: {
  active: boolean;
  supported: boolean;
  className: string;
  onToggle: (trigger: HTMLElement) => void;
}): TemplateResult {
  const label =
    !options.active && !options.supported
      ? t("shell.fullscreenUnavailable")
      : options.active
        ? t("shell.exitFullscreen")
        : t("shell.enterFullscreen");
  return html`<openclaw-tooltip .content=${label}>
    <button
      type="button"
      class=${`${options.className} shell-fullscreen-button`}
      aria-label=${label}
      aria-pressed=${options.active ? "true" : "false"}
      aria-disabled=${options.supported ? "false" : "true"}
      @click=${(event: MouseEvent) => {
        if (event.currentTarget instanceof HTMLElement) {
          options.onToggle(event.currentTarget);
        }
      }}
    >
      ${options.active ? icons.minimize : icons.maximize}
    </button>
  </openclaw-tooltip>`;
}
