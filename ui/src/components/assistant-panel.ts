import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { isSessionRouteId, type RouteId } from "../app-route-paths.ts";
import type { AssistantDockOwner } from "../app/assistant-dock.ts";
import { chatInputOwnerForContext } from "../app/chat-input-owner.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import {
  LazyCustomElementRequestController,
  isOptionalElementDefined,
} from "../app/lazy-custom-element.ts";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentId, resolveUiConversationIdentity } from "../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { renderAssistantPanelLoading } from "./assistant-panel-loading.ts";
import { DockLayoutController } from "./dock-layout-controller.ts";
import { assistantPanelLayout } from "./dock-panel-layout.ts";
import { icons } from "./icons.ts";
import { renderLazyElementState } from "./lazy-view-error.ts";
import { subscribeRightDockMotion } from "./right-dock-motion.ts";
import "../styles/rail-header.css";
import "../styles/assistant-panel.css";

const ASSISTANT_CONTENT_ELEMENT = {
  tagName: "openclaw-assistant-panel-content",
  get label() {
    return t("assistantPanel.title");
  },
  loadModule: () => import("./assistant-panel-content.ts"),
};

type AssistantSessionDestination = {
  params: Parameters<AssistantDockOwner["openSession"]>[0];
  activation: object;
};

export class OpenClawAssistantPanel extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  @property({ attribute: false })
  context: ApplicationContext | undefined;
  @property() pageSessionKey = "";
  @property() pageAgentId = "";
  @property() pageRouteId: RouteId = "chat";
  @state() private destination: AssistantSessionDestination | null = null;
  private publishedSessionKey: string | null = null;
  private clearDestinationAfterClose = false;
  private dockMotionActive = false;
  private detachDockMotion: (() => void) | null = null;
  private mountedContent = false;
  private readonly contentLoader = new LazyCustomElementRequestController(this);

  private readonly dockLayout = new DockLayoutController(this, {
    layout: assistantPanelLayout,
    reservationPrefix: "assistant",
    isAvailable: () => this.available,
    panelElement: () => this.querySelector(".assistant-panel"),
  });

  constructor() {
    super();
    void new SubscriptionsController(this)
      .effect(
        () => this.context?.assistantDock,
        (dock) => dock.attach(this),
      )
      .watchStore(() => this.context?.agentSelection)
      .watchStore(() => this.context?.agents)
      .watchStore(() => this.context?.gateway);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // One notification per motion start/end (never per frame). The second
    // transcript's load and mount must not land inside the 200ms window.
    this.detachDockMotion = subscribeRightDockMotion((event) => {
      if (event.prefix !== "assistant") {
        return;
      }
      const active = event.phase === "start";
      if (active === this.dockMotionActive) {
        return;
      }
      this.dockMotionActive = active;
      this.requestUpdate();
    });
  }

  override updated(): void {
    this.mountedContent = this.querySelector("openclaw-assistant-panel-content") !== null;
  }

  override disconnectedCallback(): void {
    this.detachDockMotion?.();
    this.detachDockMotion = null;
    this.dockMotionActive = false;
    // The destination belongs to the dock owner: a shell remount must not drop
    // the explicit session a page or plugin opened.
    this.claimInput("page");
    super.disconnectedCallback();
  }

  /**
   * A dock motion owns its 200ms window; mounting a second live transcript
   * there starves every frame (M186/M189). The window is not the same as
   * `open`: a close or a reversal keeps the motion active while `open` is
   * already false and `renderVisible` still presents the panel. Content that
   * mounted before the window keeps rendering so close has something to animate
   * out; anything unmounted waits for the settle.
   */
  private get defersContentMount(): boolean {
    return this.dockMotionActive && !this.mountedContent;
  }

  override willUpdate(): void {
    const wasOpen = this.dockLayout.open;
    this.dockLayout.setSuppressed(this.suppressed);
    if (!this.available) {
      this.dockLayout.hideWithoutPersisting();
    } else {
      this.dockLayout.restoreOpenState();
    }
    if (wasOpen && !this.dockLayout.open) {
      this.claimInput("page");
    }
    this.contentLoader.requestWhileActive(
      ASSISTANT_CONTENT_ELEMENT,
      this.dockLayout.open && this.destination !== null && !this.defersContentMount,
    );
    if (
      this.clearDestinationAfterClose &&
      !this.dockLayout.open &&
      !this.dockLayout.renderVisible
    ) {
      // The close motion has released the frame; the next explicit open
      // supplies a new target.
      this.clearDestinationAfterClose = false;
      this.destination = null;
    }
    this.dockLayout.syncReservation();
    this.publishSessionKey();
  }

  private get available(): boolean {
    return this.destination !== null;
  }

  private get suppressed(): boolean {
    const context = this.context;
    const destination = this.destination;
    if (!context || !destination || !isSessionRouteId(this.pageRouteId)) {
      return false;
    }
    const defaults = {
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    };
    const page = resolveUiConversationIdentity(defaults, this.pageSessionKey, this.pageAgentId);
    const target = resolveUiConversationIdentity(
      defaults,
      destination.params.sessionKey,
      destination.params.agentId,
    );
    return (
      page.sessionKey === target.sessionKey &&
      normalizeAgentId(page.agentId) === normalizeAgentId(target.agentId)
    );
  }

  private claimInput(region: "page" | "dock"): void {
    if (this.context) {
      chatInputOwnerForContext(this.context).claim(region);
    }
  }

  private get restoreSuppressed(): boolean {
    return this.suppressed;
  }

  openSession(params: Parameters<AssistantDockOwner["openSession"]>[0], activation: object): void {
    this.destination = { params: structuredClone(params), activation };
    this.dockLayout.setSuppressed(this.restoreSuppressed);
    this.setOpen(true);
    if (this.suppressed) {
      // Keep the destination so leaving the duplicate page can restore it.
      this.dockLayout.hideWithoutPersisting();
      this.claimInput("page");
    }
    this.publishSessionKey();
  }

  closeSession(activation?: object): void {
    if (activation && this.destination?.activation !== activation) {
      return;
    }
    this.setOpen(false);
  }

  get openSessionKey(): string | null {
    return this.dockLayout.open && !this.suppressed && this.destination
      ? this.destination.params.sessionKey
      : null;
  }

  private publishSessionKey(): void {
    const key = this.openSessionKey;
    if (key !== this.publishedSessionKey) {
      this.publishedSessionKey = key;
      this.context?.assistantDock?.notify();
    }
  }

  private setOpen(open: boolean): void {
    this.dockLayout.setOpen(open);
    this.claimInput(open ? "dock" : "page");
    // Suppression closes through the controller directly and keeps the
    // destination so leaving the page can restore it.
    this.clearDestinationAfterClose = !open;
    this.publishSessionKey();
  }

  get assistantPanelOpen(): boolean {
    return this.dockLayout.open;
  }

  override render() {
    const destination = this.destination;
    const visible = destination !== null && this.dockLayout.renderVisible;
    const dock = this.dockLayout.dock;
    const session = destination?.params;
    const contentState = this.contentLoader.visibleState;
    const contentDefined = isOptionalElementDefined(ASSISTANT_CONTENT_ELEMENT);
    const mountContent = visible && session !== undefined && !this.defersContentMount;
    const style = this.dockLayout.panelStyle(dock, this.dockLayout.height, this.dockLayout.width);
    return html`
      <section
        class="assistant-panel assistant-panel--${dock} ${this.dockLayout.motionClassName}"
        style=${style}
        ?hidden=${!visible}
        aria-label=${t("assistantPanel.title")}
        @pointerdown=${() => this.claimInput("dock")}
        @focusin=${() => this.claimInput("dock")}
      >
        ${this.dockLayout.renderResizer("assistant-panel", t("assistantPanel.resize"))}
        <div class="dock-panel-content">
          <header class="rail-header assistant-panel-header" @mousedown=${beginNativeWindowDrag}>
            <div class="assistant-panel-title">
              <openclaw-mascot .size=${16}></openclaw-mascot>
              ${
                session
                  ? html`<button
                      type="button"
                      class="assistant-panel-tab rail-header__title"
                      aria-pressed="true"
                      title=${session.label}
                    >
                      ${session.label}
                    </button>`
                  : nothing
              }
            </div>
            <div class="rail-header__actions assistant-panel-actions">
              <button
                class="rail-header__action assistant-panel-icon"
                type="button"
                aria-label=${
                  dock === "bottom" ? t("assistantPanel.dockRight") : t("assistantPanel.dockBottom")
                }
                @click=${() => this.dockLayout.setDock(dock === "bottom" ? "right" : "bottom")}
              >
                ${dock === "bottom" ? icons.panelRightOpen : icons.panelBottomOpen}
              </button>
              <button
                class="rail-header__action assistant-panel-icon"
                type="button"
                aria-label=${t("assistantPanel.close")}
                @click=${() => this.setOpen(false)}
              >
                ${icons.x}
              </button>
            </div>
          </header>
          ${
            mountContent && contentDefined
              ? html`<openclaw-assistant-panel-content
                  ?hidden=${!visible}
                  .active=${visible}
                  .sessionKey=${session.sessionKey}
                  .agentId=${session.agentId}
                  .sessionContext=${session.context}
                  .context=${this.context}
                  .pageRouteId=${this.pageRouteId}
                  .pageSessionKey=${this.pageSessionKey}
                  .pageAgentId=${this.pageAgentId}
                ></openclaw-assistant-panel-content>`
              : nothing
          }
          ${
            visible && !(mountContent && contentDefined)
              ? contentState?.status === "error"
                ? renderLazyElementState(
                    contentState,
                    () => this.contentLoader.retry(),
                    () => this.setOpen(false),
                  )
                : renderAssistantPanelLoading()
              : nothing
          }
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-assistant-panel")) {
  customElements.define("openclaw-assistant-panel", OpenClawAssistantPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-assistant-panel": OpenClawAssistantPanel;
  }
}
