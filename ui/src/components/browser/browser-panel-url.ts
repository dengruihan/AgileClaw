/**
 * URL-draft actions for the browser panel. Kept beside the controller so the
 * controller keeps its size budget; `syncUrlDraft` stays on the controller
 * because stream and native metadata callers already share that owner.
 */
import { postNativeExternalLink } from "../../app/native-link-routing.ts";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";
import type { BrowserPanelView } from "./browser-panel-surface.ts";
import { normalizeBrowserUrlDraft } from "./browser-url.ts";

export type BrowserPanelUrlHost = {
  nativeActive(): boolean;
  nativeUrl(): string | undefined;
  view(): BrowserPanelView | null;
  urlDraft(): string;
  tabs(): readonly unknown[];
  pendingNewTab(): boolean;
  setUrlDraft(url: string): void;
  openUrl(url: string, options: { newTab: boolean }): Promise<void>;
};

export class BrowserPanelUrl {
  constructor(private readonly panel: BrowserPanelUrlHost) {}

  commit(): void {
    const url = normalizeBrowserUrlDraft(this.panel.urlDraft());
    if (url) {
      void this.panel.openUrl(url, {
        newTab: this.panel.pendingNewTab() || this.panel.tabs().length === 0,
      });
    }
  }

  resetFromView(): void {
    const view = this.panel.view();
    this.panel.setUrlDraft(this.panel.nativeUrl() || view?.metrics?.url || view?.url || "");
  }

  openExternal(): void {
    const url =
      this.panel.nativeUrl() || this.panel.view()?.metrics?.url || this.panel.view()?.url || "";
    if (url && !(this.panel.nativeActive() && postNativeExternalLink(url))) {
      openExternalUrlSafe(url);
    }
  }
}
