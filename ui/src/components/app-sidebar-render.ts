import { html, nothing } from "lit";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import { serializeSidebarEntry, titleForRoute, type SidebarZoneEntry } from "../app-navigation.ts";
import { isRouteId } from "../app-route-paths.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { NativeGateway, NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { renderHoverMarquee } from "../lib/hover-marquee.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { pluginTabKey } from "../pages/plugin/route.ts";
import { renderSidebarPluginTab } from "./app-sidebar-nav-menus.ts";
import { renderSidebarSessionFilter } from "./app-sidebar-session-filter-summary.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { renderGatewayStatus } from "./gateway-status.ts";
import { icons } from "./icons.ts";
import { renderShortcutHint } from "./kbd.ts";
import { renderNewSessionLink } from "./new-session-link.ts";
import { formatSidebarBuildSubtitle } from "./sidebar-build-chip-format.ts";
import { renderSidebarReorderMenu } from "./sidebar-reorder.ts";

export type AppSidebarRenderHost = AppSidebarSessionNavigationElement & {
  activePluginTabId: string;
  teamOnlineExpanded: boolean;
  readonly people: import("./sidebar-people-controller.ts").SidebarPeopleController;
  getRouteSessionKey(): string;
  renderPinnedSidebarSession(session: SidebarRecentSession): unknown;
  toggleSection(sectionId: string): void;
};

// Display-only: read the injected global directly; the capability module must stay
// lazy to protect the startup budget.
function readSidebarNativeGateway(): NativeGateway | null {
  const snapshot = (window as Window & { __OPENCLAW_NATIVE_GATEWAYS__?: NativeGatewaysSnapshot })[
    "__OPENCLAW_NATIVE_GATEWAYS__"
  ];
  if (!snapshot || !Array.isArray(snapshot.gateways)) {
    return null;
  }
  return snapshot.gateways.find((gateway) => gateway.id === snapshot.currentId) ?? null;
}

function renderSidebarWorkspaceHeader(host: AppSidebarRenderHost) {
  return html`
    <div class="sidebar-workspace-header">
      ${
        host.sessionDataContext?.theme.branding.mascot === "none"
          ? html`<span
              class="sidebar-workspace-header__mark sidebar-workspace-header__mark--neutral"
              aria-hidden="true"
              >${icons.mark}</span
            >`
          : html`<img
              class="sidebar-workspace-header__mark"
              src=${controlUiPublicAssetPath("favicon.svg", host.basePath)}
              alt=""
              aria-hidden="true"
            />`
      }
      <span class="sidebar-workspace-header__text">
        <span class="sidebar-workspace-header__name">AgileClaw</span>
        ${
          host.sessionDataContext?.config.current.environment
            ? html`<span class="control-ui-environment-pill"
                >${host.sessionDataContext.config.current.environment.label}</span
              >`
            : nothing
        }
      </span>
    </div>
  `;
}

export function renderAppSidebarBrand(
  host: AppSidebarRenderHost,
  rosterNewSession: unknown = nothing,
) {
  const collapseLabel = t("nav.collapse");
  return html`
    <div class="sidebar-brand">
      ${renderSidebarWorkspaceHeader(host)}
      <div class="sidebar-brand__actions">
        <openclaw-tooltip
          .content=${`${collapseLabel} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.toggleSidebar)})`}
          .contentTemplate=${renderShortcutHint(collapseLabel, KEYBOARD_SHORTCUT_COMBOS.toggleSidebar)}
        >
          <button
            type="button"
            class="sidebar-brand__icon sidebar-brand__header-control sidebar-brand__desktop-control sidebar-brand__collapse"
            aria-label=${collapseLabel}
            aria-expanded="true"
            ?disabled=${!host.onToggleSidebar}
            @click=${() => host.onToggleSidebar?.()}
          >
            ${icons.panelLeftClose}
          </button>
        </openclaw-tooltip>
        ${
          host.sidebarAgentsMode === "roster"
            ? renderSidebarSessionFilter(host, "sidebar-brand__icon sidebar-brand__header-control")
            : nothing
        }
      </div>
      ${renderAppSidebarNewSessionAction(host, rosterNewSession)}
    </div>
  `;
}

/** Primary new-session action above the Pages navigation. */
function renderAppSidebarNewSessionAction(host: AppSidebarRenderHost, rosterNewSession: unknown) {
  const newSessionAccess = host.readNewSessionAccess();
  return html`
    <div class="sidebar-primary-actions">
      ${
        host.sidebarAgentsMode === "roster"
          ? rosterNewSession
          : renderNewSessionLink({
              basePath: host.basePath,
              agentId: host.expandedAgentId(),
              className: "sidebar-brand__new-thread sidebar-new-session-action",
              label: t("chat.runControls.newSession"),
              visibleLabel: t("chat.runControls.newSession"),
              showShortcut: true,
              disabledReason: newSessionAccess.allowed ? undefined : newSessionAccess.reason,
              onOpen: (agentId, target) => host.requestOpenNewSession(agentId, target),
            })
      }
    </div>
  `;
}

export function renderAppSidebarPagesHead(host: AppSidebarRenderHost) {
  return html`
    <div class="sidebar-nav__head">
      <span class="sidebar-recent-sessions__label-text sr-only">${t("nav.pages")}</span>
      <button
        type="button"
        class="sidebar-nav__head-action"
        aria-haspopup="menu"
        aria-expanded=${String(host.sidebarMenus.moreMenuPosition !== null)}
        aria-label=${t("nav.customize")}
        @click=${(event: MouseEvent) =>
          host.sidebarMenus.toggleMoreMenu(event.currentTarget as HTMLElement)}
      >
        ${icons.penLine}
      </button>
    </div>
  `;
}

/** Zone 5: product chrome recedes to one slim footer bar. */
export function renderAppSidebarFooterBar(host: AppSidebarRenderHost) {
  const connectionStatus = host.connectionStatus;
  const selfUser = host.sessionDataContext
    ? gatewayPresentationScope(host.sessionDataContext.gateway).displayUser
    : null;
  const selfLabel = selfUser?.name ?? selfUser?.email ?? t("nav.owner");
  const avatarUser = {
    id: "owner",
    ...selfUser,
    name: selfLabel,
    watchedSessions: [],
  };
  const gateway = readSidebarNativeGateway();
  const buildSubtitle = formatSidebarBuildSubtitle(CONTROL_UI_BUILD_INFO);
  const gatewayPrimaryTag = gateway?.isPrimary ? t("nav.gateway.primaryTag") : null;
  const identityMenuLabel = t("profilePage.identity.menuButtonLabel", { name: selfLabel });
  const statusLabel = connectionStatus ? t(`connection.${connectionStatus}`) : null;
  const identityDetail = statusLabel
    ? statusLabel
    : gateway
      ? `${gateway.name}${gatewayPrimaryTag ? `, ${gatewayPrimaryTag}` : ""}`
      : buildSubtitle;
  const announcement = statusLabel ?? (host.connected ? t("nav.gateway.connected") : "");
  return html`
    <div class="sidebar-footer-bar sidebar-footer-bar--one-action">
      <button
        type="button"
        class="sidebar-identity-card"
        aria-haspopup="menu"
        aria-expanded=${String(host.sidebarMenus.identityMenuPosition !== null)}
        aria-label=${identityDetail ? `${identityMenuLabel}: ${identityDetail}` : identityMenuLabel}
        @click=${(event: MouseEvent) =>
          host.sidebarMenus.toggleIdentityMenu(event.currentTarget as HTMLElement)}
      >
        <openclaw-viewer-avatar .user=${avatarUser} variant="footer"></openclaw-viewer-avatar>
        <span class="sidebar-identity-card__text">
          ${renderHoverMarquee(selfLabel, "sidebar-identity-card__name", { loop: true, delay: 300, speed: 35 })}
          ${
            connectionStatus
              ? renderGatewayStatus({
                  kind: connectionStatus,
                  lastError: host.lastError,
                  announce: false,
                })
              : gateway
                ? html`<span class="sidebar-identity-card__gateway" aria-hidden="true">
                    <span class="sidebar-gateway-name">${gateway.name}</span>
                    ${gatewayPrimaryTag ? html`<span class="sidebar-gateway-primary">${gatewayPrimaryTag}</span>` : nothing}
                  </span>`
                : nothing
          }
        </span>
      </button>
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true"
        >${announcement}</span
      >
      <span class="sidebar-footer-actions">
        <openclaw-sidebar-attention
          .activeRouteId=${host.activeRouteId}
          .onNavigate=${host.onNavigate}
          .watchUpdateProgress=${host.watchUpdateProgress}
        ></openclaw-sidebar-attention>
      </span>
    </div>
  `;
}

export function renderAppSidebarZoneEntry(
  host: AppSidebarRenderHost,
  entry: SidebarZoneEntry,
  sessionRows: ReadonlyMap<string, SidebarRecentSession>,
  pluginTabs: ReadonlyMap<string, GatewayControlUiPluginTab>,
) {
  if (entry.type === "route" && !host.sidebarMenus.isRouteEnabled(entry.route)) {
    return nothing;
  }
  const serialized = serializeSidebarEntry(entry);
  const dropPosition =
    host.sessionOrganizer.sidebarZoneDropTarget?.entry === serialized
      ? host.sessionOrganizer.sidebarZoneDropTarget.position
      : null;
  const pluginTab = entry.type === "plugin" ? pluginTabs.get(entry.key) : undefined;
  const content =
    entry.type === "route"
      ? host.sidebarMenus.renderRoute(entry.route)
      : pluginTab
        ? renderAppSidebarPluginTab(host, pluginTab)
        : entry.type === "plugin"
          ? html`<openclaw-plugin-contributions
              .kind=${"navigation"}
              .navigationKey=${entry.key}
            ></openclaw-plugin-contributions>`
          : sessionRows.has(entry.key)
            ? host.renderPinnedSidebarSession(sessionRows.get(entry.key)!)
            : nothing;
  const draggable = entry.type === "route" || entry.type === "plugin";
  const label =
    entry.type === "route"
      ? titleForRoute(entry.route)
      : entry.type === "session"
        ? (sessionRows.get(entry.key)?.label ?? entry.key)
        : (pluginTab?.label ??
          host.pluginNavigation().find((item) => item.key === entry.key)?.value.label ??
          entry.key);
  return html`
    <div
      class="sidebar-zone-entry ${dropPosition ? `sidebar-zone-entry--drop-${dropPosition}` : ""} ${
        host.sessionOrganizer.draggingSidebarEntry === serialized
          ? "sidebar-zone-entry--dragging"
          : ""
      }"
      data-sidebar-entry=${serialized}
      draggable=${draggable ? "true" : "false"}
      @dragstart=${
        entry.type === "route"
          ? (event: DragEvent) => host.sessionOrganizer.startSidebarRouteDrag(event, entry.route)
          : entry.type === "plugin"
            ? (event: DragEvent) => host.sessionOrganizer.startSidebarPluginDrag(event, entry.key)
            : nothing
      }
      @dragend=${draggable ? () => host.sessionOrganizer.finishSidebarEntryDrag() : nothing}
      @dragover=${(event: DragEvent) =>
        host.sessionOrganizer.handleSidebarZoneDragOver(event, serialized)}
      @drop=${(event: DragEvent) => host.sessionOrganizer.handleSidebarZoneDrop(event, serialized)}
    >
      ${content}
      ${renderSidebarReorderMenu({
        label,
        kind: "entry",
        onMove: async (target, position) => {
          host.sessionOrganizer.writeSidebarEntryAt(serialized, target, position);
          host.requestUpdate();
          await host.updateComplete;
        },
      })}
    </div>
  `;
}

function renderAppSidebarPluginTab(host: AppSidebarRenderHost, tab: GatewayControlUiPluginTab) {
  const ref = { pluginId: tab.pluginId, id: tab.id };
  const key = pluginTabKey(ref);
  const routePlacement = tab.placement?.startsWith("route:")
    ? tab.placement.slice("route:".length)
    : "";
  const routeId = isRouteId(routePlacement) ? routePlacement : null;
  return routeId
    ? host.sidebarMenus.renderRoute(routeId)
    : renderSidebarPluginTab({
        tab,
        basePath: host.basePath,
        active: host.activeRouteId === "plugin" && host.activePluginTabId === key,
        onNavigate: (location) => host.onNavigate?.("plugin", location),
      });
}
