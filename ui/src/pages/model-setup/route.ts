import { definePage, redirect } from "@openclaw/uirouter";
import { nothing } from "lit";
import { pathForRoute, routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";

export const page = definePage({
  ...routePageSpec("model-setup"),
  // The pre-redesign setup page is gone. Saved setup links open the one current
  // connection entry point on Models.
  loader: (context: ApplicationContext) =>
    redirect({
      pathname: pathForRoute("model-providers", context.basePath),
      search: "?connect=1",
      hash: "",
    }),
  // Redirect routes still require a module by contract, but never render page content.
  component: async () => ({ header: true, render: () => nothing }),
});
