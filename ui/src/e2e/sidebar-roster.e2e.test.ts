import { expect, it } from "vitest";
import type {
  AgentsListResult,
  CronJob,
  GatewaySessionRow,
  SessionsListResult,
} from "../api/types.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";
import {
  chooseSidebarOwner,
  closeSidebarMenu,
  openSidebarMenu,
} from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI sidebar agent roster" });

suite.define(() => {
  it("groups all agents' sessions, switches context, filters groups, and restores collapsed groups", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 800, width: 1280 } },
      async ({ page }) => {
        const agentsList: AgentsListResult = {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "main", name: "Harbor", identity: { emoji: "⚓" } },
            { id: "forge", name: "Forge", identity: { emoji: "🔧" } },
            { id: "scout", name: "Scout", identity: { emoji: "🔭" } },
            { id: "bloom", name: "Bloom", identity: { emoji: "🌱" } },
          ],
        };
        const now = Date.now();
        const owners = [
          { type: "human", id: "profile-riley", label: "Riley" },
          { type: "human", id: "profile-devon", label: "Devon" },
        ] as const;
        const sessions = {
          ts: now,
          path: "",
          count: agentsList.agents.length * 3,
          defaults: { model: null, modelProvider: null, contextTokens: null },
          owners: [...owners],
          sessions: agentsList.agents.flatMap(
            (agent, index): Array<GatewaySessionRow & { updatedAt: number }> => [
              {
                key: `agent:${agent.id}:main`,
                kind: "direct",
                label: agent.name ?? agent.id,
                updatedAt: now - 600_000,
                agentId: agent.id,
                isMain: true,
                lastMessagePreview:
                  agent.id === "forge"
                    ? "Preparing the sample dashboard."
                    : "Ready for the next task.",
              },
              ...["project", "notes"].map(
                (suffix, sessionIndex): GatewaySessionRow & { updatedAt: number } => ({
                  key: `agent:${agent.id}:${suffix}`,
                  kind: "direct",
                  label: `${agent.name} ${suffix}`,
                  updatedAt: now - (index + 1) * 60_000 - sessionIndex * 1_000,
                  agentId: agent.id,
                  pinned: sessionIndex === 0,
                  owner: { actor: sessionIndex === 0 ? owners[0] : owners[1] },
                  hasActiveRun: agent.id === "forge" && sessionIndex === 0,
                  status: agent.id === "forge" && sessionIndex === 0 ? "running" : "done",
                  unread: agent.id === "scout" && sessionIndex === 1,
                  lastMessagePreview:
                    agent.id === "forge"
                      ? "Preparing the sample dashboard."
                      : "Ready for the next task.",
                }),
              ),
            ],
          ),
        } satisfies SessionsListResult;
        const jobs = ["main", "forge"].map((agentId): CronJob => ({
          id: `${agentId}-daily`,
          agentId,
          configRevision: `${agentId}-revision`,
          name: `${agentId === "main" ? "Harbor" : "Forge"} daily review`,
          enabled: true,
          createdAtMs: now,
          updatedAtMs: now,
          schedule: { kind: "cron", expr: "0 9 * * *" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "Review the sample project." },
          state: { nextRunAtMs: now + 86_400_000 },
        }));
        const jobList = (agentId?: string) => ({
          jobs: jobs.filter((job) => !agentId || job.agentId === agentId),
          snapshotRevision: "team-jobs",
          total: agentId ? 1 : 2,
          offset: 0,
          limit: 50,
          hasMore: false,
          nextOffset: null,
        });
        await page.addInitScript((key) => {
          if (!localStorage.getItem(key)) {
            localStorage.setItem(key, JSON.stringify({ sidebarAgentsMode: "roster" }));
          }
        }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
        const gateway = await installMockGateway(page, {
          sessions: sessions.sessions,
          methodResponses: {
            "agents.list": agentsList,
            "agent.identity.get": {
              cases: agentsList.agents.map((agent) => ({
                match: { agentId: agent.id },
                response: {
                  agentId: agent.id,
                  name: agent.name,
                  emoji: agent.identity?.emoji,
                  avatar: "",
                },
              })),
            },
            "chat.startup": {
              agentsList,
              messages: [],
              metadata: { models: [] },
              sessionId: "session:agent:main:main",
              thinkingLevel: null,
            },
            "sessions.list": sessions,
            "cron.list": cronListResponseFixture([
              ...["main", "forge"].map((agentId) => ({
                match: { agentId },
                response: jobList(agentId),
              })),
              { match: {}, response: jobList() },
            ]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        await waitForControlUiRoute(page, { routeId: "chat" });
        const sidebar = page.locator("openclaw-app-sidebar");
        const workspace = sidebar.locator(".sidebar-workspace-header__name");
        const expectWorkspace = async () => {
          await expect.poll(() => workspace.textContent()).toBe("AgileClaw");
        };
        const sessionRows = sidebar.locator(".sidebar-recent-session");
        const headers = sidebar.locator(".sidebar-agent-roster__row");
        await expect.poll(() => headers.count()).toBe(4);
        await expect
          .poll(() =>
            headers.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-agent-id"))),
          )
          .toEqual(["main", "forge", "scout", "bloom"]);
        await expect.poll(() => sessionRows.count()).toBe(12);
        expect(await sidebar.getByRole("link", { name: "Home", exact: true }).count()).toBe(0);
        await expectWorkspace();
        expect(await sidebar.locator(".sidebar-session-toolbar").count()).toBe(0);
        expect(await sidebar.locator(".sidebar-brand__actions .sidebar-session-sort").count()).toBe(
          1,
        );
        for (const agent of agentsList.agents) {
          const group = sidebar.locator(`[data-agent-group="${agent.id}"]`);
          const pin = sidebar.locator(
            `.sidebar-nav [data-session-key="agent:${agent.id}:project"]`,
          );
          expect(await pin.count()).toBe(1);
          expect(await pin.textContent()).toContain(`${agent.name} project`);
          expect(await pin.locator(".identity-avatar--agent").count()).toBe(1);
          // Anchor and member rows share one list; the pinned project row lives in Pages.
          expect(
            await group
              .locator(".sidebar-recent-session")
              .evaluateAll((rows) => rows.map((row) => row.dataset.sessionKey)),
          ).toEqual([`agent:${agent.id}:main`, `agent:${agent.id}:notes`]);
          expect(
            await group
              .getByRole("link", { name: `New conversation: ${agent.name}`, exact: true })
              .getAttribute("href"),
          ).toBe(`/new?agent=${agent.id}`);
          // The header labels the group; only the session rows navigate.
          expect(await group.locator(".sidebar-agent-roster__row").getAttribute("href")).toBeNull();
        }
        expect(
          await sidebar
            .locator('[data-session-key="agent:scout:notes"] .session-unread-dot')
            .count(),
        ).toBe(1);
        expect(
          (await headers.first().locator(".sidebar-agent-roster__copy").textContent())?.trim(),
        ).toBe("Harbor");
        // The group header is a label now; the active conversation marks its row.
        expect(await headers.first().getAttribute("aria-current")).toBeNull();
        expect(
          await sidebar
            .locator('[data-session-key="agent:main:main"] .sidebar-recent-session__link')
            .getAttribute("aria-current"),
        ).toBe("page");
        // Re-query every row by key: the sidebar commits again while the activity
        // read is held, so element handles captured in one pass can detach.
        // Measure the tab's leading gap in the tab's own untransformed layout
        // coordinates. Screen-rect reads sampled across the sidebar's async
        // commits can catch transient relayout frames (the R2 round measured
        // 7.9248 on a gap whose settled screen reads and this offset read are
        // exactly 8px, and the failure screenshot shows no visible spacing
        // loss), and a pulled tab makes screen reads animation-frame
        // sensitive; offsetLeft chains ignore transforms and animation
        // frames while still measuring the same user-visible flex gap
        // between the lead slot and the title. The link is the positioned
        // containing block for the title, and the indicator (position:
        // relative) is the offsetParent for the lead glyph, so the lead's
        // offset chains through the indicator rather than sharing the
        // title's offsetParent.
        const measuredLeads = await (async () => {
          const keys = await sessionRows.evaluateAll((rows) =>
            rows.map((row) => row.dataset.sessionKey ?? ""),
          );
          let measured = 0;
          for (const key of keys) {
            const row = sidebar
              .locator(`.sidebar-recent-session[data-session-key="${key}"]`)
              .first();
            const frame = await row.evaluate((element) => {
              const indicator = element.querySelector(".sidebar-session-indicator");
              const lead = element.querySelector(".session-glyph");
              const title = element.querySelector(".sidebar-recent-session__name");
              if (!indicator || !lead || !title) {
                return null;
              }
              return {
                leadStart: indicator.offsetLeft + lead.offsetLeft,
                leadWidth: lead.offsetWidth,
                titleStart: title.offsetLeft,
              };
            });
            const leadLocator = row.locator(".sidebar-session-indicator .session-glyph");
            // Plain member rows render no lead glyph (frame null); every row
            // that does keeps the documented gap before its title.
            if (!frame || (await leadLocator.count()) === 0) {
              continue;
            }
            measured += 1;
            // The renderer reports fractional layout values (a pinned row measures
            // 7.98 px for the 8 px gap); allow sub-pixel rounding only.
            expect(
              frame!.titleStart - (frame!.leadStart + frame!.leadWidth),
              key,
            ).toBeGreaterThanOrEqual(8 - 0.05);
          }
          return measured;
        })();
        expect(measuredLeads).toBeGreaterThanOrEqual(8);
        await page.mouse.move(600, 60);
        await captureSidebarUiProof(suite, page, "sidebar-roster-after.png");

        const activityQuery = {
          archived: "all",
          includeDerivedTitles: true,
          includeLastMessage: true,
          limit: 100,
        };
        const activityReads = () => gateway.getRequests("sessions.list", activityQuery);
        const initialReads = (await activityReads()).length;
        await gateway.deferNext("sessions.list", activityQuery);
        await gateway.emitGatewayEvent("sessions.changed", {
          agentId: "main",
          key: "agent:main:main",
        });
        await expect.poll(async () => (await activityReads()).length).toBe(initialReads + 1);
        for (let index = 0; index < 3; index += 1) {
          await gateway.emitGatewayEvent("sessions.changed", {
            agentId: "main",
            key: "agent:main:main",
          });
          // Exercise separate debounce windows while the original server read stays held.
          await page.waitForTimeout(250);
          expect(await activityReads()).toHaveLength(initialReads + 1);
        }
        await gateway.resolveDeferred("sessions.list");
        await expect.poll(async () => (await activityReads()).length).toBe(initialReads + 2);
        await expect.poll(() => sessionRows.count()).toBe(12);

        await sidebar.locator(".sidebar-brand__new-thread").click();
        const newMenu = sidebar.locator(".sidebar-primary-actions .sidebar-new-session-menu");
        await expect.poll(() => newMenu.locator("wa-dropdown-item").first().isVisible()).toBe(true);
        expect(
          await newMenu
            .locator("wa-dropdown-item a")
            .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
        ).toEqual(["main", "forge", "scout", "bloom"].map((id) => `/new?agent=${id}`));
        await newMenu.locator('wa-dropdown-item[value="scout"]').click();
        await waitForControlUiRoute(page, { routeId: "new-session", pathname: "/new" });
        expect(new URL(page.url()).searchParams.get("agent")).toBe("scout");
        await sidebar
          .locator('[data-session-key="agent:forge:main"] .sidebar-recent-session__link')
          .click();
        await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/forge" });
        await expect
          .poll(() =>
            sidebar
              .locator('[data-session-key="agent:forge:main"] .sidebar-recent-session__link')
              .getAttribute("aria-current"),
          )
          .toBe("page");
        expect(await sidebar.locator('[data-session-key="agent:forge:main"]').count()).toBe(1);
        await sidebar.getByRole("link", { name: "Automations", exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "cron" });
        await expect.poll(() => page.locator(".cron-table__row").count()).toBe(2);
        expect(
          await page.locator(".cron-table__row openclaw-agent-row-chip").allTextContents(),
        ).toEqual([expect.stringContaining("Harbor"), expect.stringContaining("Forge")]);
        expect((await gateway.getRequests("cron.list")).at(-1)?.params).not.toHaveProperty(
          "agentId",
        );
        await captureSidebarUiProof(suite, page, "sidebar-team-automations.png");

        await sidebar
          .locator('[data-session-key="agent:forge:notes"] .sidebar-recent-session__link')
          .click();
        await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/forge/notes" });
        await expectWorkspace();
        await expect.poll(() => sessionRows.count()).toBe(12);
        await sidebar.locator(".sidebar-session-sort").click();
        await openSidebarMenu(page);
        expect(
          await sidebar
            .locator(".sidebar-session-sort-menu")
            .locator("#sidebar-sessions-group")
            .count(),
        ).toBe(0);
        expect(
          await sidebar
            .locator(".sidebar-session-sort-menu")
            .getByRole("radiogroup", { name: "Hide empty groups", exact: true })
            .count(),
        ).toBe(0);
        await openSidebarMenu(page);
        await chooseSidebarOwner(page, "owner:profile-riley");
        await closeSidebarMenu(page);
        await expect.poll(() => sessionRows.count()).toBe(4);
        expect(await sessionRows.allTextContents()).toEqual([
          expect.stringContaining("Harbor project"),
          expect.stringContaining("Forge project"),
          expect.stringContaining("Scout project"),
          expect.stringContaining("Bloom project"),
        ]);
        await sidebar.locator(".sidebar-session-sort").click();
        await openSidebarMenu(page);
        await chooseSidebarOwner(page, "all");
        await closeSidebarMenu(page);
        await expect.poll(() => sessionRows.count()).toBe(12);

        await sidebar.locator('[data-agent-collapse="bloom"]').click();
        // Collapsing the group hides its anchor and notes rows; its pinned row stays.
        await expect.poll(() => sessionRows.count()).toBe(10);
        expect(new URL(page.url()).pathname).toBe("/chat/forge/notes");
        await page.reload();
        await expect.poll(() => headers.count()).toBe(4);
        await expect
          .poll(() =>
            sidebar.locator('[data-agent-collapse="bloom"]').getAttribute("aria-expanded"),
          )
          .toBe("false");
        // Collapsing the group hides its anchor and notes rows; its pinned row stays.
        await expect.poll(() => sessionRows.count()).toBe(10);
        await expectWorkspace();
        const forgeGroup = sidebar.locator('[data-agent-group="forge"]');
        const actions = forgeGroup.locator(".sidebar-agent-roster__actions");
        // The header label is not focusable now; the collapse control leads the
        // group's keyboard order, then its actions.
        await forgeGroup.locator("[data-agent-collapse]").focus();
        await page.keyboard.press("Tab");
        await expect
          .poll(() => actions.locator("a").evaluate((el) => el === document.activeElement))
          .toBe(true);
        await page.keyboard.press("Tab");
        const options = actions.getByRole("button", { name: "Options for Forge" });
        await expect.poll(() => options.evaluate((el) => el === document.activeElement)).toBe(true);
        await page.keyboard.press("Space");
        await actions.getByRole("menuitem", { name: "All sessions", exact: true }).waitFor();
        expect(await actions.locator("wa-dropdown-item").allTextContents()).toEqual([
          expect.stringContaining("All sessions"),
          expect.stringContaining("Collapse others"),
        ]);
        await actions.getByRole("menuitem", { name: "All sessions", exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "sessions", pathname: "/sessions" });
        await expect
          .poll(async () =>
            (await gateway.getRequests("sessions.list")).map((request) => request.params),
          )
          .toEqual(expect.arrayContaining([expect.objectContaining({ agentId: "forge" })]));
        await expect
          .poll(() =>
            page
              .locator(".agent-scope-control openclaw-agent-select")
              .evaluate((el: HTMLElement & { value?: string }) => el.value),
          )
          .toBe("forge");
        await options.press("Enter");
        await actions.getByRole("menuitem", { name: "Collapse others", exact: true }).click();
        await expect
          .poll(() => sidebar.locator('[data-agent-collapse][aria-expanded="false"]').count())
          .toBe(3);
        expect(
          await forgeGroup.locator("[data-agent-collapse]").getAttribute("aria-expanded"),
        ).toBe("true");
        await page.reload();
        await expect
          .poll(() => sidebar.locator('[data-agent-collapse][aria-expanded="false"]').count())
          .toBe(3);
        // The menu no longer offers "Open main chat"; dismiss it and open the
        // agent's ordinary anchor row instead.
        await options.press("Enter");
        await page.keyboard.press("Escape");
        await sidebar
          .locator('[data-session-key="agent:forge:main"] .sidebar-recent-session__link')
          .click();
        await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/forge" });
        await actions.locator("a").press("Space");
        await waitForControlUiRoute(page, { routeId: "new-session", pathname: "/new" });
        expect(new URL(page.url()).searchParams.get("agent")).toBe("forge");
      },
    );
  });
});
