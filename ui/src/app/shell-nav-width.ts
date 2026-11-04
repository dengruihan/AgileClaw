import { NAV_WIDTH_DEFAULT, NAV_WIDTH_MAX } from "./settings.ts";

/** Rail floor while a tablet splits width between navigation and a narrow column. */
const TABLET_NAV_MIN_WIDTH = 320;
/** Above the drawer breakpoint and its landscape rung, before large-laptop widths. */
const TABLET_NAV_MIN_VIEWPORT = 933;
const TABLET_NAV_MAX_VIEWPORT = 1320;
/** Phones, portrait tablets, and native rails keep the stored width. */
export function resolveShellNavWidth(params: {
  navWidth: number;
  viewportWidth: number;
  coarsePointer: boolean;
}): number {
  const navWidth = Math.min(NAV_WIDTH_MAX, Math.max(0, params.navWidth));
  if (
    !params.coarsePointer ||
    params.viewportWidth < TABLET_NAV_MIN_VIEWPORT ||
    params.viewportWidth > TABLET_NAV_MAX_VIEWPORT
  ) {
    return navWidth;
  }
  // Only the compact default rail yields to the tablet floor; a wider rail the
  // operator dragged themselves stays where it was put.
  if (navWidth > NAV_WIDTH_DEFAULT) {
    return navWidth;
  }
  return Math.min(NAV_WIDTH_MAX, Math.max(navWidth, TABLET_NAV_MIN_WIDTH));
}
