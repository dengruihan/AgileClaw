import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import type { GatewaySessionRow, SessionBranch } from "../../../api/types.ts";
import { beginNativeWindowDrag } from "../../../app/native-window-drag.ts";
import {
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  type ShellNavDrawerToggleDetail,
} from "../../../app/shell-nav-drawer-event.ts";
import { icons } from "../../../components/icons.ts";
import {
  personActivityLink,
  renderStandalonePersonLink,
  type PersonActivityRouting,
} from "../../../components/person-activity-link.ts";
import { renderSessionOwnerChip } from "../../../components/session-owner-chip.ts";
import { renderShellFullscreenButton } from "../../../components/shell-fullscreen.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import type { ChatPageHost } from "../chat-state-host.ts";
import {
  ensureSidebarConversation,
  promoteSidebarPanel,
  setSidebarDock,
  setSidebarExpanded,
  sidebarActivePanel,
  sidebarDock,
  sidebarMainPanel,
  type SidebarLayout,
} from "../sidebar-layout.ts";
import type { SidebarPanelDefinition } from "./chat-sidebar-region-types.ts";

type ChatPaneHeaderProps = {
  paneId: string;
  narrow: boolean;
  mergedChrome: boolean;
  navDrawerOpen?: boolean;
  /** Accessible name for the header group; the visible title lives in the session menu. */
  title: string;
  session: GatewaySessionRow | undefined;
  showOwnerChip?: boolean;
  ownerViewing?: boolean;
  personActivity?: PersonActivityRouting;
  catalog: boolean;
  branches: SessionBranch[];
  branchSwitchDisabledReason: string | null;
  actionsDisabled?: boolean;
  panelActions: TemplateResult | typeof nothing;
  runAction?: TemplateResult | typeof nothing;
  panelLayoutActions: TemplateResult | typeof nothing;
  presence?: TemplateResult | typeof nothing;
  sharingControl?: TemplateResult | typeof nothing;
  publicAccessIndicator?: TemplateResult | typeof nothing;
  placementControl?: TemplateResult | typeof nothing;
  deviceScopeControl?: TemplateResult | typeof nothing;
  sessionMenuAction: TemplateResult | typeof nothing;
  /** Whole-page fullscreen control; the shell owns its state and the toggle. */
  fullscreen?: {
    active: boolean;
    supported: boolean;
    onToggle: (trigger: HTMLElement) => void;
  } | null;
  onBranchSelect: (leafEntryId: string) => void;
  onOpenSplitView?: () => void;
  onSplitDown?: (paneId: string) => void;
  onSplitRight?: (paneId: string) => void;
  onClosePane?: (paneId: string) => void;
};

export function renderChatPaneHeader(props: ChatPaneHeaderProps) {
  const drawerLabel = props.navDrawerOpen ? t("nav.collapse") : t("nav.expand");
  const compactSessionActions = props.narrow && props.sessionMenuAction !== nothing;
  const hasSharingControl = props.sharingControl !== undefined && props.sharingControl !== nothing;

  return html`
    <div
      class=${`chat-pane__header${props.onClosePane ? " chat-pane__header--closable" : ""}`}
      role="group"
      aria-label=${props.title}
      tabindex="-1"
      @mousedown=${beginNativeWindowDrag}
    >
      <div class="chat-pane__header-leading">
        ${
          props.mergedChrome
            ? html`<openclaw-tooltip .content=${drawerLabel}>
                <button
                  class="btn btn--ghost btn--icon chat-icon-btn chat-pane__nav-toggle"
                  type="button"
                  aria-label=${drawerLabel}
                  aria-expanded=${String(Boolean(props.navDrawerOpen))}
                  @click=${(event: MouseEvent) => {
                    window.dispatchEvent(
                      new CustomEvent<ShellNavDrawerToggleDetail>(SHELL_NAV_DRAWER_TOGGLE_EVENT, {
                        detail: { trigger: event.currentTarget as HTMLElement },
                      }),
                    );
                  }}
                >
                  ${icons.menu}
                </button>
              </openclaw-tooltip>`
            : nothing
        }
        ${
          props.session?.incognito
            ? html`<span
                class="chat-pane__incognito"
                role="img"
                aria-label=${t("chat.sessionHeader.incognito")}
                title=${t("chat.sessionHeader.incognito")}
                >${icons.lock}</span
              >`
            : nothing
        }
        ${props.publicAccessIndicator ?? nothing}
        ${
          hasSharingControl
            ? props.sharingControl
            : renderStandalonePersonLink(
                renderSessionOwnerChip(
                  props.showOwnerChip ? props.session?.owner?.actor : undefined,
                  "header",
                  props.session?.owner?.assignedAt !== undefined ? "owned" : "created",
                  props.ownerViewing,
                ),
                props.showOwnerChip
                  ? personActivityLink(
                      props.session?.owner?.actor.identity?.type === "profile"
                        ? props.session.owner.actor.identity.id
                        : undefined,
                      props.personActivity,
                      props.session?.owner?.actor.label,
                    )
                  : null,
              )
        }
        ${
          props.showOwnerChip && props.session?.participants?.length
            ? html`<openclaw-viewer-facepile
                class="chat-pane__participants"
                .staticParticipants=${props.session.participants}
                .totalCount=${props.session.participantCount}
                .maxVisible=${4}
                .personActivity=${props.personActivity}
                variant="session"
              ></openclaw-viewer-facepile>`
            : nothing
        }
        ${props.placementControl ?? nothing} ${props.deviceScopeControl ?? nothing}
        ${props.presence ?? nothing}
      </div>
      <div class="chat-pane__header-trailing">
        ${
          !props.catalog && props.branches.length > 1
            ? html`
                <wa-dropdown
                  class="chat-pane__branches-menu"
                  placement="bottom-end"
                  @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
                    const leafEntryId = event.detail.item.value;
                    const branch = props.branches.find(
                      (candidate) => candidate.leafEntryId === leafEntryId,
                    );
                    if (
                      leafEntryId &&
                      branch &&
                      !branch.active &&
                      !props.branchSwitchDisabledReason
                    ) {
                      props.onBranchSelect(leafEntryId);
                    }
                  }}
                >
                  <button
                    slot="trigger"
                    class="btn btn--ghost btn--icon chat-icon-btn chat-pane__branches-trigger"
                    type="button"
                    ?disabled=${Boolean(props.branchSwitchDisabledReason)}
                    title=${props.branchSwitchDisabledReason ?? t("chat.sessionHeader.branches")}
                    aria-label=${t("chat.sessionHeader.branches")}
                  >
                    ${icons.gitBranch}
                  </button>
                  ${props.branches.map((branch) => {
                    const updatedAt = Date.parse(branch.updatedAt ?? "");
                    const relativeTime = formatRelativeTimestamp(updatedAt, { fallback: "" });
                    return html`
                      <wa-dropdown-item
                        class="chat-pane__branch-item"
                        value=${branch.leafEntryId}
                        ?disabled=${branch.active || Boolean(props.branchSwitchDisabledReason)}
                        data-active=${branch.active ? "true" : "false"}
                      >
                        <span class="chat-pane__branch-copy">
                          <span class="chat-pane__branch-headline"
                            >${branch.headline || t("chat.sessionHeader.untitledBranch")}</span
                          >
                          <span class="chat-pane__branch-meta"
                            >${t(
                              branch.messageCount === 1
                                ? "chat.sessionHeader.oneMessage"
                                : "chat.sessionHeader.messages",
                              { count: String(branch.messageCount) },
                            )}${relativeTime ? ` · ${relativeTime}` : ""}</span
                          >
                        </span>
                        ${
                          branch.active
                            ? html`<span
                                class="chat-pane__branch-active"
                                aria-label=${t("chat.sessionHeader.activeBranch")}
                                >${icons.check}</span
                              >`
                            : nothing
                        }
                      </wa-dropdown-item>
                    `;
                  })}
                </wa-dropdown>
              `
            : nothing
        }
        <div class="chat-pane__actions">
          ${props.runAction ?? nothing} ${props.panelLayoutActions}
          <fieldset class="chat-pane__actions" ?disabled=${props.actionsDisabled}>
            ${compactSessionActions ? nothing : props.panelActions}
            ${(
              [
                [
                  props.onOpenSplitView && !compactSessionActions,
                  "chat-open-split-view",
                  "chat.splitView.open",
                  icons.columns2,
                  props.onOpenSplitView,
                ],
                [
                  !props.narrow && props.onSplitDown,
                  "chat-pane__split-down",
                  "chat.splitView.splitDown",
                  icons.panelBottomOpen,
                  () => props.onSplitDown?.(props.paneId),
                ],
                [
                  !props.narrow && props.onSplitRight,
                  "chat-pane__split-right",
                  "chat.splitView.splitRight",
                  icons.panelRightOpen,
                  () => props.onSplitRight?.(props.paneId),
                ],
                [
                  props.onClosePane,
                  "chat-pane__close-pane",
                  "chat.splitView.closePane",
                  icons.x,
                  () => props.onClosePane?.(props.paneId),
                ],
              ] as const
            ).map(([visible, className, label, icon, onClick]) =>
              visible
                ? html`<openclaw-tooltip .content=${t(label)}>
                    <button
                      class=${`btn btn--ghost btn--icon chat-icon-btn ${className}`}
                      type="button"
                      aria-label=${t(label)}
                      @click=${onClick}
                    >
                      ${icon}
                    </button>
                  </openclaw-tooltip>`
                : nothing,
            )}
            ${props.sessionMenuAction}
          </fieldset>
          ${
            props.fullscreen
              ? renderShellFullscreenButton({
                  active: props.fullscreen.active,
                  supported: props.fullscreen.supported,
                  className: "btn btn--ghost btn--icon chat-icon-btn chat-pane__fullscreen",
                  onToggle: props.fullscreen.onToggle,
                })
              : nothing
          }
        </div>
      </div>
    </div>
  `;
}

export function renderChatPanePanelToggle(props: {
  label: string;
  icon: TemplateResult;
  className?: string;
  expanded?: boolean;
  onToggle: () => void;
}) {
  return html`<openclaw-tooltip .content=${props.label}>
    <button
      class="btn btn--ghost btn--icon chat-icon-btn ${props.className ?? ""}"
      type="button"
      aria-label=${props.label}
      aria-expanded=${ifDefined(props.expanded === undefined ? undefined : String(props.expanded))}
      @click=${props.onToggle}
    >
      ${props.icon}
    </button>
  </openclaw-tooltip>`;
}

export function renderChatPanePanelLayoutActions(
  layout: SidebarLayout | undefined,
  definitions: SidebarPanelDefinition[],
  narrow: boolean,
  onLayoutChange: ChatPageHost["updateSidebarLayout"],
) {
  if (!layout) {
    return nothing;
  }
  const side = sidebarActivePanel(layout);
  const mainSlot = sidebarMainPanel(layout)?.slot ?? "conversation";
  const mainDefinition = definitions.find((definition) => definition.slot === mainSlot);
  const sideDefinition = definitions.find((definition) => definition.slot === side?.slot);
  const split = layout.open === true && !layout.expanded;
  const focusLabel = t(layout.expanded ? "chat.sidePanel.restore" : "chat.sidePanel.expand");
  const swapLabel =
    mainDefinition && sideDefinition
      ? t("chat.sidePanel.swap", { main: mainDefinition.label, side: sideDefinition.label })
      : "";
  return html`${
    mainDefinition?.headerAction
      ? html`<span class="side-panel__action-group side-panel__action-group--content"
          >${mainDefinition.headerAction}</span
        >`
      : nothing
  }
  ${
    split || layout.expanded
      ? html`<openclaw-tooltip .content=${focusLabel}>
          <button
            class="btn btn--ghost btn--icon chat-icon-btn chat-panel-focus"
            type="button"
            aria-pressed=${String(layout.expanded === true)}
            aria-label=${focusLabel}
            @click=${() =>
              onLayoutChange(
                setSidebarExpanded(ensureSidebarConversation(layout), layout.expanded !== true),
                { dashboardPresentation: "personal" },
              )}
          >
            ${layout.expanded ? icons.minimize : icons.maximize}
          </button>
        </openclaw-tooltip>`
      : nothing
  }
  ${
    split && side && swapLabel
      ? html`<openclaw-tooltip .content=${swapLabel}>
          <button
            class="btn btn--ghost btn--icon chat-icon-btn chat-panel-swap"
            type="button"
            aria-label=${swapLabel}
            @click=${() => onLayoutChange(promoteSidebarPanel(layout, side.id))}
          >
            ${icons.arrowLeftRight}
          </button>
        </openclaw-tooltip>`
      : nothing
  }
  ${
    narrow || !split
      ? nothing
      : html`<wa-dropdown
          class="chat-panel-layout-menu"
          placement="bottom-end"
          @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
            const dock = event.detail.item.value;
            if (dock === "left" || dock === "right" || dock === "bottom") {
              onLayoutChange(setSidebarDock(layout, dock), {
                geometryOnly: true,
              });
            }
          }}
        >
          <button
            slot="trigger"
            class="btn btn--ghost btn--icon chat-icon-btn"
            type="button"
            aria-label=${t("chat.sidePanel.layout")}
            title=${t("chat.sidePanel.layout")}
          >
            ${icons.columns2}
          </button>
          ${(
            [
              ["left", "dockLeft", icons.panelLeftOpen],
              ["right", "dockRight", icons.panelRightOpen],
              ["bottom", "dockBottom", icons.panelBottomOpen],
            ] as const
          ).map(
            ([dock, label, icon]) => html`<wa-dropdown-item
              value=${dock}
              type="checkbox"
              ?checked=${sidebarDock(layout) === dock}
              ><span slot="icon">${icon}</span>${t(`chat.sidePanel.${label}`)}</wa-dropdown-item
            >`,
          )}
        </wa-dropdown>`
  }`;
}
