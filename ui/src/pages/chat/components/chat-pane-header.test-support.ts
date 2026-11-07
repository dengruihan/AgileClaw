import { html, nothing, render } from "lit";
import { vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { renderChatPaneHeader } from "./chat-pane-header.ts";

export type ChatPaneHeaderProps = Parameters<typeof renderChatPaneHeader>[0];

export function chatPaneHeaderSessionRow(
  patch: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return { key: "agent:main:test", kind: "direct", updatedAt: 0, ...patch };
}

/**
 * Mounts the header with every required prop filled in. Callers own teardown so each suite
 * keeps its own afterEach; `containers` collects the mounted nodes for removal.
 */
export function mountChatPaneHeader(
  containers: HTMLElement[],
  patch: Partial<ChatPaneHeaderProps> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const props: ChatPaneHeaderProps = {
    paneId: "pane-1",
    narrow: false,
    mergedChrome: false,
    title: "Session title",
    session: chatPaneHeaderSessionRow(),
    catalog: false,
    branches: [],
    branchSwitchDisabledReason: null,
    panelActions: nothing,
    panelLayoutActions: nothing,
    sessionMenuAction: nothing,
    onBranchSelect: vi.fn(),
    ...patch,
  };
  render(html`${renderChatPaneHeader(props)}`, container);
  return { container, props };
}
