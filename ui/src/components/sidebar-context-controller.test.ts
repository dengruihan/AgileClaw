/* @vitest-environment jsdom */
import { createRouter, definePage } from "@openclaw/uirouter";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationRouter, RouteId } from "../app-routes.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createGateway, createSessions, mountSidebar } from "../test-helpers/app-sidebar.ts";
import "./app-sidebar.ts";

setupSidebarTest();

type RouteModule = NonNullable<
  ReturnType<ApplicationRouter["getState"]>["matches"][number]["module"]
>;

it("updates contextual navigation from its router and retires the subscription on detach", async () => {
  const loaded = createDeferred<unknown>();
  const router = createRouter<RouteId, unknown, RouteModule>({
    routes: [
      definePage({
        id: "sessions",
        path: "/sessions",
        component: () => ({
          render: () => "workspace",
          renderSidebar: (_data: unknown, pending: boolean) =>
            pending ? "loading sessions" : "session filters",
        }),
        loader: () => loaded.promise,
      }),
      definePage({ id: "cron", path: "/cron", component: () => ({ render: () => "cron" }) }),
    ],
  });
  onTestFinished(() => router.stop());
  const { sidebar } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    createSessions("main", []),
  );
  sidebar.router = router;
  await sidebar.updateComplete;
  const navigation = router.navigate("sessions", {});
  await vi.waitFor(() => expect(sidebar.contextualSidebar?.loaderPending).toBe(true));
  const pending = sidebar.contextualSidebar;
  const data = { session: "alpha" };
  loaded.resolve(data);
  await navigation;
  await sidebar.updateComplete;
  expect(sidebar.contextualSidebar?.loaderPending).toBe(false);
  expect(sidebar.contextualSidebar?.data).toBe(data);
  expect(pending?.loaderPending).toBe(true);
  expect(sidebar.querySelector(".sidebar-shell__body")?.textContent).toContain("session filters");
  sidebar.remove();
  expect(sidebar.contextualSidebar).toBeUndefined();
  await router.navigate("cron", {});
  await router.navigate("sessions", {});
  expect(sidebar.contextualSidebar).toBeUndefined();
});
