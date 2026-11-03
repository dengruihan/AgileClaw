import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("passwords"),
  component: () =>
    import("./passwords-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-passwords-page></openclaw-passwords-page>`,
    })),
});
