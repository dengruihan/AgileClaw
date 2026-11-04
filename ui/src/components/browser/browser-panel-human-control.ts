import type { BrowserHumanControl } from "./browser-client.ts";
import {
  cancelBrowserHumanControl,
  claimBrowserHumanControl,
  readBrowserHumanControl,
  releaseBrowserHumanControl,
} from "./browser-human-control-client.ts";
/**
 * Owns the Control UI side of a tab-scoped human takeover.
 *
 * The capability token stays inside this object; the panel only asks whether
 * sensitive input is active. Status is refreshed from the tab snapshot and a
 * low-frequency poll while the panel is open, so an agent-requested takeover
 * appears without a chat round trip.
 */
import type {
  BrowserPanelControllerHost,
  BrowserPanelOperationOwnership,
} from "./browser-panel-operation-ownership.ts";

const HUMAN_CONTROL_POLL_MS = 4_000;

export type BrowserPanelHumanControlPanel = {
  readonly host: Pick<
    BrowserPanelControllerHost,
    "isConnected" | "browserPanelIsOpen" | "renderRoot" | "updateComplete"
  >;
  readonly operations: Pick<
    BrowserPanelOperationOwnership,
    "captureClient" | "isLive" | "epoch" | "route"
  >;
  readonly native: { readonly activeTab: unknown };
  activeTargetId(): string | null;
  requestUpdate(): void;
  reportError(error: unknown): void;
  refreshView(targetId: string): Promise<void>;
};

export class BrowserPanelHumanControl {
  private token: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private current: BrowserHumanControl | null = null;
  private supported = true;

  constructor(private readonly panel: BrowserPanelHumanControlPanel) {}

  control(): BrowserHumanControl | null {
    return this.current;
  }

  isSupported(): boolean {
    return this.supported;
  }

  available(): boolean {
    return (
      this.supported &&
      !this.panel.native.activeTab &&
      this.panel.operations.route?.target !== "node"
    );
  }

  tokenForInput(): string | undefined {
    return this.current?.status === "active" ? (this.token ?? undefined) : undefined;
  }

  sensitiveInputActive(): boolean {
    return this.tokenForInput() !== undefined;
  }

  clearToken(): void {
    this.token = null;
  }

  resetForTab(): void {
    this.token = null;
    this.current = null;
    this.supported = true;
    this.panel.requestUpdate();
  }

  apply(control: BrowserHumanControl | null, supported = true): void {
    const previous = this.current;
    if (
      control?.status === "active" &&
      previous?.status === "active" &&
      control.generation === previous.generation &&
      this.token
    ) {
      // Keep the capability across passive status refreshes for the same lease.
      this.supported = supported;
      this.current = control;
      this.panel.requestUpdate();
      return;
    }
    if (!control || control.status !== "active" || previous?.generation !== control.generation) {
      this.token = null;
    }
    this.supported = supported;
    this.current = control;
    this.panel.requestUpdate();
    if (control?.status === "active" && this.token) {
      this.focusInput();
    }
  }

  applyTab(
    activeId: string,
    tabs: readonly { id: string; control?: BrowserHumanControl }[],
    supported: boolean,
  ): void {
    this.apply(tabs.find((tab) => tab.id === activeId)?.control ?? null, supported);
  }

  async refresh(): Promise<void> {
    const client = this.panel.operations.captureClient();
    const targetId = this.panel.activeTargetId();
    if (!client || !targetId) {
      this.apply(null, false);
      return;
    }
    try {
      const state = await readBrowserHumanControl(client, { targetId });
      if (
        this.panel.activeTargetId() !== targetId ||
        !this.panel.operations.isLive(this.panel.operations.epoch, client)
      ) {
        return;
      }
      this.apply(state.control, state.supported);
    } catch {
      // A closed or navigated tab clears its lease on the next tab listing.
    }
  }

  async takeOver(): Promise<void> {
    const client = this.panel.operations.captureClient();
    const targetId = this.panel.activeTargetId();
    if (!client || !targetId) {
      return;
    }
    try {
      const result = await claimBrowserHumanControl(client, {
        targetId,
        reason: this.current?.reason ?? "user_request",
      });
      if (this.panel.activeTargetId() !== targetId) {
        return;
      }
      this.token = result.token;
      this.supported = true;
      this.current = result.control;
      this.panel.requestUpdate();
      this.focusInput();
    } catch (error) {
      this.panel.reportError(error);
      await this.refresh();
    }
  }

  async handBack(): Promise<void> {
    const client = this.panel.operations.captureClient();
    const targetId = this.panel.activeTargetId();
    const token = this.token;
    if (!client || !targetId || !token) {
      return;
    }
    try {
      await releaseBrowserHumanControl(client, { targetId, humanControlToken: token });
      if (this.panel.activeTargetId() === targetId) {
        this.token = null;
        this.current = null;
        this.panel.requestUpdate();
        await this.panel.refreshView(targetId);
      }
    } catch (error) {
      this.panel.reportError(error);
      await this.refresh();
    }
  }

  async cancel(): Promise<void> {
    const client = this.panel.operations.captureClient();
    const targetId = this.panel.activeTargetId();
    const token = this.token;
    if (!client || !targetId || !token) {
      return;
    }
    try {
      await cancelBrowserHumanControl(client, { targetId, humanControlToken: token });
      if (this.panel.activeTargetId() === targetId) {
        this.token = null;
        this.current = null;
        this.panel.requestUpdate();
      }
    } catch (error) {
      this.panel.reportError(error);
      await this.refresh();
    }
  }

  schedulePoll(): void {
    this.stopPolling();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.panel.host.isConnected && this.panel.host.browserPanelIsOpen()) {
        void this.refresh();
        this.schedulePoll();
      }
    }, HUMAN_CONTROL_POLL_MS);
  }

  stopPolling(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Clear a capability rejected by another client and refresh ownership. */
  noteActError(error: unknown): void {
    const details = (error as { details?: { code?: unknown; status?: unknown } } | null)?.details;
    if (details?.code === "ACT_HUMAN_CONTROL" || details?.status === "needs_human") {
      this.token = null;
      void this.refresh();
    }
  }

  private focusInput(): void {
    const epoch = this.panel.operations.epoch;
    void this.panel.host.updateComplete.then(() => {
      if (this.panel.operations.isLive(epoch) && this.panel.activeTargetId()) {
        this.panel.host.renderRoot.querySelector<HTMLTextAreaElement>(".bp-input")?.focus({
          preventScroll: true,
        });
      }
    });
  }
}
