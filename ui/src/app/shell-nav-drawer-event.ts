export const SHELL_NAV_DRAWER_TOGGLE_EVENT = "openclaw:shell-nav-drawer-toggle";

export type ShellNavDrawerToggleDetail = {
  trigger: HTMLElement;
};

export function shellNavDrawerTriggerFromEvent(event: Event): HTMLElement | undefined {
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
  const trigger =
    detail && typeof detail === "object" && "trigger" in detail ? detail.trigger : null;
  return trigger instanceof HTMLElement ? trigger : undefined;
}
