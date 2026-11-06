import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar shared scroller", () => {
  it("drives the fade state from the shared scroller's own scroll events", async () => {
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      createSessions("main", ["agent:main:main"]),
    );
    const scroller = sidebar.querySelector<HTMLElement>(".sidebar-shell__body");
    if (!scroller) {
      throw new Error("expected the shared sidebar scroller");
    }
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 300 },
    });

    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    await sidebar.updateComplete;
    expect(scroller.classList.contains("sidebar-shell__body--scroll-top")).toBe(true);

    scroller.scrollTop = 600;
    scroller.dispatchEvent(new Event("scroll"));
    await sidebar.updateComplete;
    expect(scroller.classList.contains("sidebar-shell__body--scroll-middle")).toBe(false);
    expect(scroller.classList.contains("sidebar-shell__body--scroll-bottom")).toBe(true);
  });

  it("keeps the session list mounted as the only lower-sidebar content", async () => {
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      createSessions("main", ["agent:main:main"]),
    );
    for (const routeId of ["activity", "dashboards", "sessions"] as const) {
      sidebar.activeRouteId = routeId;
      await sidebar.updateComplete;
      const content = sidebar.querySelector<HTMLElement>(".sidebar-session-content");
      expect(content).not.toBeNull();
      expect(content?.hasAttribute("hidden")).toBe(false);
    }
  });
});
