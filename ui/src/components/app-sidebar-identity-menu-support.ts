import { html } from "lit";
import { t } from "../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { icons, type IconName } from "./icons.ts";
import { consumeDropdownKeyboardDismissal } from "./web-awesome.ts";

// External rows of the footer identity menu. Docs-first: public docs pages over
// raw GitHub, matching the ClawSweeper docs-link policy for user-facing copy.
const IDENTITY_MENU_LINKS: ReadonlyArray<{
  href: string;
  icon: IconName;
  label: () => string;
}> = [
  { href: "https://docs.openclaw.ai", icon: "book", label: () => t("common.docs") },
  {
    href: "https://docs.openclaw.ai/help",
    icon: "messageSquare",
    label: () => t("agentChip.getHelp"),
  },
  { href: "https://discord.gg/clawd", icon: "users", label: () => t("agentChip.discord") },
  {
    href: "https://docs.openclaw.ai/releases",
    icon: "scrollText",
    label: () => t("agentChip.viewChangelog"),
  },
];

export const COMMAND_VALUE_PREFIX = "command:";
const LINK_VALUE_PREFIX = "link:";
function sidebarMenuItems(dropdown: Element | null) {
  return [
    ...(dropdown?.querySelectorAll<HTMLElement & { active: boolean }>(
      ":scope > wa-dropdown-item:not([disabled])",
    ) ?? []),
  ];
}

function focusSidebarMenuItem(
  items: Array<HTMLElement & { active: boolean }>,
  target: HTMLElement,
) {
  items.forEach((item) => (item.active = item === target));
  target.focus({ preventScroll: true });
  target.scrollIntoView?.({ block: "nearest" });
}

// Nested overlays bubble lifecycle events through the dropdown. Only the
// owner's completed hide may remove its menu or consume its Escape state.
export function closeMenuAfterOwnDropdownHide(
  event: Event,
  onClose: (restoreFocus?: boolean) => void,
) {
  if (event.target !== event.currentTarget) {
    return;
  }
  onClose(consumeDropdownKeyboardDismissal(event));
}

export function consumeSidebarMenuSelection(
  event: CustomEvent<{ item: HTMLElement & { value?: string } }>,
  onClose: (restoreFocus?: boolean) => void,
): string | undefined {
  event.preventDefault();
  const item = event.detail.item;
  if (item.dataset.nativeNavigation) {
    delete item.dataset.nativeNavigation;
    onClose(false);
    return undefined;
  }
  const value = item.value;
  if (value) {
    onClose(false);
    if (value.startsWith(LINK_VALUE_PREFIX)) {
      openExternalUrlSafe(decodeURIComponent(value.slice(LINK_VALUE_PREFIX.length)));
      return undefined;
    }
  }
  return value;
}

export function moveSidebarMenuFocus(event: KeyboardEvent): boolean {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    return false;
  }
  if (event.target instanceof HTMLInputElement && (event.key === "Home" || event.key === "End")) {
    return false;
  }
  const dropdown =
    event.currentTarget instanceof Element ? event.currentTarget.closest("wa-dropdown") : null;
  const items = sidebarMenuItems(dropdown);
  const footer = dropdown?.querySelector<HTMLElement>(".sidebar-identity-menu__footer");
  const controls = [
    ...items,
    ...(footer?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []),
  ];
  const current = event.target instanceof HTMLElement ? event.target : null;
  const index = current ? controls.indexOf(current) : -1;
  if (footer && index < 0) {
    return false;
  }
  const direction = event.key === "ArrowDown" ? 1 : -1;
  const target =
    event.key === "Home"
      ? items[0]
      : event.key === "End"
        ? items.at(-1)
        : index < 0
          ? items.at(direction === 1 ? 0 : -1)
          : controls[(index + direction + controls.length) % controls.length];
  if (!target || (footer && !footer.contains(current) && !footer.contains(target))) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  // Native footer actions are outside Web Awesome's roving item list; reset
  // its active row on both crossings so reverse navigation cannot skip one.
  focusSidebarMenuItem(items, target);
  return true;
}

function renderIdentityMenuHelpSubmenu() {
  return html`
    ${IDENTITY_MENU_LINKS.map(
      (link) => html`
        <wa-dropdown-item
          slot="submenu"
          class="sidebar-customize-menu__item"
          value=${`${LINK_VALUE_PREFIX}${encodeURIComponent(link.href)}`}
          data-new-tab-action
          @click=${(event: MouseEvent) => {
            if (
              event.target instanceof Element &&
              event.target.closest("a") &&
              event.currentTarget instanceof HTMLElement
            ) {
              event.currentTarget.dataset.nativeNavigation = "true";
            }
          }}
        >
          <a
            href=${link.href}
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            tabindex="-1"
          >
            <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons[link.icon]}</span>
            <span class="sidebar-customize-menu__text">${link.label()}</span>
          </a>
        </wa-dropdown-item>
      `,
    )}
  `;
}

export function renderSidebarHelpMenu() {
  return html`
    <wa-dropdown-item
      class="sidebar-customize-menu__item sidebar-identity-menu__help"
      value="command:help"
    >
      <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.circleQuestionMark}</span>
      <span class="sidebar-customize-menu__text">${t("agentChip.help")}</span>
      ${renderIdentityMenuHelpSubmenu()}
    </wa-dropdown-item>
  `;
}
