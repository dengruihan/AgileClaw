import type { RouteLoaderOptions, RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { page } from "./route.ts";

const location: RouteLocation = {
  pathname: "/settings/model-setup",
  search: "",
  hash: "",
};

describe("model setup route", () => {
  it.each(["?firstRun=1", "?firstRun=explicit", "?firstRun=0&firstRun=explicit", ""])(
    "redirects the retired setup link %s to the Models connection entry",
    async (search) => {
      const context = { basePath: "/ui" } as ApplicationContext;
      const options: RouteLoaderOptions = {
        signal: new AbortController().signal,
        shouldRun: () => true,
        revalidating: false,
        location: { ...location, pathname: "/ui/settings/model-setup", search },
        deps: search,
        cause: "navigation",
      };
      expect(await page.loader?.(context, options)).toEqual({
        type: "redirect",
        location: { pathname: "/ui/settings/model-providers", search: "?connect=1", hash: "" },
      });
    },
  );
});
