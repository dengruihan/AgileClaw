import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import {
  buildHomeWorkContext,
  subscribeChatWorkContext,
  type ChatWorkContext,
} from "../pages/chat/chat-work-context.ts";
import "./home-session.runtime.ts";
import "../styles/assistant-panel-content.css";

/** Conversation runtimes load inside the already-open dock. */
export class OpenClawAssistantPanelContent extends OpenClawLightDomElement {
  @property({ type: Boolean }) active = false;
  @property() destination: "home" | "session" = "home";
  @property() sessionKey = "";
  @property() agentId = "";
  @property({ attribute: false }) sessionContext: ChatWorkContext | undefined;
  @property({ attribute: false }) context: ApplicationContext | undefined;
  @property() pageRouteId: RouteId = "chat";
  @property() pageSessionKey = "";
  @property() pageAgentId = "";

  constructor() {
    super();
    void new SubscriptionsController(this)
      .watch(
        () => this.context,
        (context, notify) => subscribeChatWorkContext(context, notify),
      )
      .watchStore(() => this.context?.sessions)
      .watchStore(() => this.context?.agents)
      .watchStore(() => this.context?.gateway);
  }

  override render() {
    if (!this.active) {
      return nothing;
    }
    return html`<openclaw-home-session
      .sessionKey=${this.sessionKey}
      .agentId=${this.agentId}
      .workContext=${
        this.sessionContext ??
        (this.context
          ? buildHomeWorkContext(
              this.context,
              this.pageRouteId,
              this.pageSessionKey,
              this.pageAgentId,
            )
          : undefined)
      }
    ></openclaw-home-session>`;
  }
}

customElements.define("openclaw-assistant-panel-content", OpenClawAssistantPanelContent);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-assistant-panel-content": OpenClawAssistantPanelContent;
  }
}
