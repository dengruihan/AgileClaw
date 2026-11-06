import { html, nothing } from "lit";
import { renderLazyElementModal } from "../components/lazy-view-error.ts";
import {
  debugOverlayTemplate,
  renderPendingDebugOverlay,
  type DebugOverlayFrameHost,
} from "../pages/debug/debug-overlay-frame.ts";
import type { ShellNewSessionHost } from "./app-shell-new-session.ts";
import {
  isOptionalElementDefined,
  type LazyCustomElementRequestController,
  DEBUG_OVERLAY_ELEMENT,
  KEYBOARD_SHORTCUTS_ELEMENT,
} from "./lazy-custom-element.ts";
import { normalizeChatSendShortcut } from "./settings.ts";

export interface ShellLazyOverlayHost extends DebugOverlayFrameHost, ShellNewSessionHost {
  readonly lazyCustomElements: LazyCustomElementRequestController;
}

/** Shell-level optional dialogs share lazy-load recovery, not route ownership. */
export function renderShellLazyOverlays(host: ShellLazyOverlayHost, nativeEmbed: boolean) {
  const lazyElementState = host.lazyCustomElements.visibleState;
  const uiSettings = host.context?.theme.settings;
  return html`
    ${
      lazyElementState?.element === DEBUG_OVERLAY_ELEMENT
        ? renderPendingDebugOverlay(host, lazyElementState)
        : renderLazyElementModal(host.lazyCustomElements)
    }
    ${isOptionalElementDefined(DEBUG_OVERLAY_ELEMENT) ? debugOverlayTemplate : nothing}
    ${
      !nativeEmbed && isOptionalElementDefined(KEYBOARD_SHORTCUTS_ELEMENT)
        ? html`<openclaw-keyboard-shortcuts-dialog
            .sendShortcut=${normalizeChatSendShortcut(uiSettings?.chatSendShortcut)}
            .newSessionHost=${host}
          ></openclaw-keyboard-shortcuts-dialog>`
        : nothing
    }
  `;
}
