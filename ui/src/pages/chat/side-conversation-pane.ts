import type { ApplicationContext } from "../../app/context.ts";
import {
  SESSION_COMPOSER_FOCUS_PARAM,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { ownedChatPaneRouteData } from "./chat-page-navigation.ts";
import type { SessionChatRouteData } from "./route-loader.ts";
import type { SideConversationOpenDetail } from "./side-conversation-events.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";
import { insertPane, panesOf, setActivePane } from "./split-layout.ts";

export type SideConversationPaneHost = {
  context: ApplicationContext;
  data: SessionChatRouteData;
  layout: ChatSplitLayout | undefined;
  classicLayout: (sessionKey?: string) => ChatSplitLayout;
  persistLayout: (layout: ChatSplitLayout) => void;
};

export type SideConversationPageOwner = SideConversationPaneHost & {
  presented: boolean;
  pendingCreate: boolean;
};

/** Event handler for a page that shows the parent; retained previews stay inert. */
export function createSideConversationOpenHandler(page: () => SideConversationPageOwner) {
  return (event: Event) => {
    const detail =
      event instanceof CustomEvent
        ? (event.detail as SideConversationOpenDetail | undefined)
        : undefined;
    const owner = page();
    if (!detail || !owner.presented || owner.pendingCreate) {
      return;
    }
    if (openSideConversationPane(owner, detail)) {
      event.preventDefault();
    }
  };
}

/**
 * Opens one hidden child as a real split pane next to its parent and routes to
 * its exact key, so a refresh restores both panes from the persisted layout.
 * Returns false when this page does not show the parent (retained previews
 * ignore another route's request).
 */
export function openSideConversationPane(
  host: SideConversationPaneHost,
  detail: SideConversationOpenDetail,
): boolean {
  const parentSessionKey = detail.parentSessionKey?.trim();
  const childSessionKey = detail.childSessionKey?.trim();
  if (!parentSessionKey || !childSessionKey) {
    return false;
  }
  const layout =
    host.layout ?? host.classicLayout(ownedChatPaneRouteData(host.context, host.data).sessionKey);
  const parentPane = panesOf(layout).find((pane) =>
    areUiSessionKeysEquivalent(pane.sessionKey, parentSessionKey),
  );
  if (!parentPane) {
    return false;
  }
  const existing = panesOf(layout).find((pane) => pane.sessionKey === childSessionKey);
  host.persistLayout(
    existing
      ? setActivePane(layout, existing.id)
      : insertPane(layout, parentPane.id, childSessionKey, "right"),
  );
  host.context.replace("chat", sideConversationChildRoute(host.context, childSessionKey, detail));
  return true;
}

/** A child keeps its own route; only a one-shot draft asks for composer focus. */
export function sideConversationChildRoute(
  context: ApplicationContext,
  childSessionKey: string,
  detail: Pick<SideConversationOpenDetail, "draft" | "agentId">,
) {
  const target = sessionNavigationTarget({
    context,
    face: "chat",
    sessionKey: childSessionKey,
    ...(detail.agentId ? { agentId: detail.agentId } : {}),
    focusComposer: detail.draft !== undefined,
  });
  const params = new URLSearchParams(target.options.search ?? "");
  params.delete("draft");
  params.delete(SESSION_COMPOSER_FOCUS_PARAM);
  if (detail.draft !== undefined) {
    params.set("draft", detail.draft);
    params.set(SESSION_COMPOSER_FOCUS_PARAM, "1");
  }
  const search = params.toString();
  return {
    pathname: target.options.pathname,
    ...(search ? { search: `?${search}` } : {}),
  };
}
