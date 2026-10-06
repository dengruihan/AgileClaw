import { definePage, redirect } from "@openclaw/uirouter";
import { pathForRoute, routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";

export const page = definePage({
  ...routePageSpec("model-setup"),
  loader: (context: ApplicationContext) =>
    redirect({
      pathname: pathForRoute("model-providers", context.basePath),
      search: "?connect=1",
      hash: "",
    }),
  component: () => null,
});
