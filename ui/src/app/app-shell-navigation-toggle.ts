type NavigationContext = {
  readonly navigation: {
    readonly snapshot: { readonly navCollapsed: boolean };
    update(patch: { navCollapsed: boolean }): void;
  };
};

/** The shell facts the desktop navigation toggle reads and applies. */
export interface ShellDesktopNavigationHost {
  readonly context: NavigationContext | undefined;
  readonly updateComplete: Promise<boolean>;
  navDrawerOpen: boolean;
  desktopNavigationExpanded: boolean;
  closeNavDrawer(options?: { restoreFocus?: boolean }): void;
  querySelector<T extends Element = Element>(selectors: string): T | null;
}

export type ShellDesktopNavigationOptions = {
  dismissTransientMenus: () => void;
  restoreFocus: (target: HTMLElement | null | undefined) => void;
};

/**
 * Owns the desktop navigation toggle's state application and focus settle.
 *
 * The navigation state applies on the click; the rail's CSS width/opacity
 * transition carries the chat column, so there is no pending state or second
 * phase. Focus moves onto the collapsed chrome only after the host has rendered
 * it, and a later toggle or disconnect invalidates that settle.
 */
export class ShellDesktopNavigationToggle {
  private generation = 0;

  constructor(private readonly host: ShellDesktopNavigationHost) {}

  run(options: ShellDesktopNavigationOptions): void {
    const host = this.host;
    // A responsive handoff expands the rail without overwriting the desktop
    // preference; the click state combines the drawer, the preference, and
    // that flag.
    const navigation = host.context?.navigation.snapshot;
    const collapsed =
      host.navDrawerOpen || !(navigation?.navCollapsed && !host.desktopNavigationExpanded);
    if (collapsed) {
      options.dismissTransientMenus();
    }
    host.closeNavDrawer();
    host.context?.navigation.update({ navCollapsed: collapsed });
    host.desktopNavigationExpanded = false;
    if (!collapsed) {
      return;
    }
    // The instant input/state paths keep focus where the user put it; only a
    // focus left in the departing rail or on the body moves to the expand
    // control once the collapsed chrome exists.
    const generation = ++this.generation;
    void host.updateComplete.then(() => {
      if (generation !== this.generation) {
        return;
      }
      const active = document.activeElement;
      if (
        !active ||
        active === document.body ||
        host.querySelector(".shell-nav")?.contains(active)
      ) {
        options.restoreFocus(host.querySelector<HTMLElement>(".shell-chrome-controls__nav-toggle"));
      }
    });
  }

  /** Disconnect or a superseding navigation path cancels the pending focus move. */
  cancel(): void {
    this.generation += 1;
  }
}
