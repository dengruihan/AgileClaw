// Control UI E2E tests cover the direct IDENTITY.md editor in the files panel.
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent identity file",
  browserLaunchOptions: { headless: true },
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const proofDir =
  process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
    ? createControlUiE2eArtifactDir("agent-identity-file")
    : undefined;

async function capture(page: Page, name: string) {
  if (!proofDir) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

const WORKSPACE = "/tmp/openclaw-e2e/workspace-main";

function identityContent(name: string) {
  return `# IDENTITY.md - Agent Identity\n\n- Name: ${name}\n- Avatar: identity.png\n`;
}

function fileList() {
  return {
    agentId: "main",
    workspace: WORKSPACE,
    files: [
      { name: "AGENTS.md", path: `${WORKSPACE}/AGENTS.md`, missing: false },
      { name: "SOUL.md", path: `${WORKSPACE}/SOUL.md`, missing: false },
    ],
  };
}

function fileGet(name: string, content: string, hash: string) {
  return {
    agentId: "main",
    workspace: WORKSPACE,
    file: { name, path: `${WORKSPACE}/${name}`, missing: false, content, hash },
  };
}

function identityFileResponses(name: string, hash: string) {
  return {
    cases: [
      {
        match: { agentId: "main", name: "IDENTITY.md" },
        response: fileGet("IDENTITY.md", identityContent(name), hash),
      },
      { response: fileGet("AGENTS.md", "# Main instructions\n", "a".repeat(64)) },
    ],
  };
}

function identityResponses(avatarStatus: "local" | "data", name = "Main") {
  return {
    cases: [
      {
        match: { agentId: "main" },
        response: { agentId: "main", avatar: "", avatarStatus, name },
      },
      { response: { agentId: "main", avatar: "", avatarStatus, name } },
    ],
  };
}

function requestName(request: { params?: unknown }): string | undefined {
  const params = request.params as { name?: unknown } | undefined;
  return typeof params?.name === "string" ? params.name : undefined;
}

suite.define(() => {
  it("edits IDENTITY.md from the files panel and refreshes the identity form after saving", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "agent.identity.get",
            "agents.files.get",
            "agents.files.list",
            "agents.files.set",
            "agents.list",
            "agents.update",
          ],
          methodResponses: {
            "agent.identity.get": identityResponses("local"),
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [{ id: "main", name: "Main" }],
            },
            "agents.files.list": fileList(),
            "agents.files.get": identityFileResponses("Main", "1".repeat(64)),
            "agents.files.set": {
              ok: true,
              ...fileGet("IDENTITY.md", identityContent("Renamed"), "2".repeat(64)),
            },
          },
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        });

        await page.goto(`${suite.server.baseUrl}settings/agents/main/files`);
        await expect
          .poll(() => page.locator(".agent-file-textarea").inputValue())
          .toBe("# Main instructions\n");
        await page.locator('[id="agent-files-tab-IDENTITY.md"]').click();
        const editor = page.locator(".agent-file-textarea");
        await expect.poll(() => editor.inputValue()).toBe(identityContent("Main"));
        const read = await gateway.waitForRequest("agents.files.get");
        expect(read.params).toMatchObject({ agentId: "main", name: "IDENTITY.md" });
        await expect
          .poll(() => page.locator(".agent-file-identity-hint").textContent())
          .toContain("managed by the Identity form");
        await capture(page, "00-identity-editor.png");

        await editor.fill(identityContent("Renamed"));
        const identityReadsBeforeSave = (await gateway.getRequests("agent.identity.get")).length;
        const rosterReadsBeforeSave = (await gateway.getRequests("agents.list")).length;
        await page
          .locator(".agent-file-actions")
          .getByRole("button", { name: "Save", exact: true })
          .click();
        const write = await gateway.waitForRequest("agents.files.set");
        expect(write.params).toMatchObject({
          agentId: "main",
          name: "IDENTITY.md",
          content: identityContent("Renamed"),
          expectedHash: "1".repeat(64),
        });
        await expect
          .poll(async () => (await gateway.getRequests("agent.identity.get")).length)
          .toBeGreaterThan(identityReadsBeforeSave);
        await expect
          .poll(async () => (await gateway.getRequests("agents.list")).length)
          .toBeGreaterThan(rosterReadsBeforeSave);
        await capture(page, "01-identity-saved.png");
      },
    );
  });

  it("surfaces IDENTITY.md save conflicts with reload and overwrite resolutions", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "agent.identity.get",
            "agents.files.get",
            "agents.files.list",
            "agents.files.set",
            "agents.list",
          ],
          methodResponses: {
            "agent.identity.get": identityResponses("local"),
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [{ id: "main", name: "Main" }],
            },
            "agents.files.list": fileList(),
            "agents.files.get": identityFileResponses("Main", "1".repeat(64)),
            "agents.files.set": {
              __mockError: {
                code: "INVALID_REQUEST",
                message: 'agent file "IDENTITY.md" changed since it was read',
                details: { type: "agent_file_conflict", name: "IDENTITY.md" },
              },
            },
          },
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        });

        await page.goto(`${suite.server.baseUrl}settings/agents/main/files`);
        await page.locator('[id="agent-files-tab-IDENTITY.md"]').click();
        const editor = page.locator(".agent-file-textarea");
        await expect.poll(() => editor.inputValue()).toBe(identityContent("Main"));
        await editor.fill(identityContent("Workspace-won edit"));
        await page
          .locator(".agent-file-actions")
          .getByRole("button", { name: "Save", exact: true })
          .click();
        const conflict = page.locator(".callout.danger");
        await expect
          .poll(() => conflict.getByText("changed since it was read").isVisible())
          .toBe(true);
        await capture(page, "02-identity-conflict.png");

        await gateway.setMethodResponse(
          "agents.files.get",
          identityFileResponses("Workspace-won edit", "9".repeat(64)),
        );
        await conflict.getByRole("button", { name: "Reload" }).click();
        // Wait for the authoritative reload to clear the conflict before editing;
        // its settlement rebases a clean draft and would drop an early edit.
        await expect.poll(() => page.locator(".callout.danger").count()).toBe(0);
        await expect.poll(() => editor.inputValue()).toBe(identityContent("Workspace-won edit"));
        await editor.fill(identityContent("Overwriting edit"));
        await gateway.setMethodResponse("agents.files.set", {
          ok: true,
          ...fileGet("IDENTITY.md", identityContent("Overwriting edit"), "3".repeat(64)),
        });
        await page
          .locator(".agent-file-actions")
          .getByRole("button", { name: "Save", exact: true })
          .click();
        await expect.poll(() => page.locator(".callout.danger").count()).toBe(0);
        await expect.poll(() => editor.inputValue()).toBe(identityContent("Overwriting edit"));
      },
    );
  });

  it("holds IDENTITY.md on migration guidance instead of loading an embedded Base64 avatar", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "agent.identity.get",
            "agents.files.get",
            "agents.files.list",
            "agents.files.set",
            "agents.list",
          ],
          methodResponses: {
            "agent.identity.get": identityResponses("data"),
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [{ id: "main", name: "Main" }],
            },
            "agents.files.list": fileList(),
            "agents.files.get": identityFileResponses("Main", "1".repeat(64)),
          },
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        });

        await page.goto(`${suite.server.baseUrl}settings/agents/main/files`);
        await page.locator('[id="agent-files-tab-IDENTITY.md"]').click();
        const held = page.locator(".agent-file-identity-held");
        await expect
          .poll(() => held.getByText("still embedded in IDENTITY.md as Base64").isVisible())
          .toBe(true);
        expect(await page.locator(".agent-file-textarea").count()).toBe(0);
        expect(
          (await gateway.getRequests("agents.files.get")).some(
            (request) => requestName(request) === "IDENTITY.md",
          ),
        ).toBe(false);
        await capture(page, "03-identity-held-migration.png");

        await held.getByRole("button", { name: "Open identity form" }).click();
        await expect.poll(() => page.locator(".agent-identity-editor").isVisible()).toBe(true);
      },
    );
  });

  it("refreshes the IDENTITY.md editor after the overview identity form rewrites it", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "agent.identity.get",
            "agents.files.get",
            "agents.files.list",
            "agents.files.set",
            "agents.list",
            "agents.update",
          ],
          methodResponses: {
            "agent.identity.get": identityResponses("local"),
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [{ id: "main", name: "Main" }],
            },
            "agents.files.list": fileList(),
            "agents.files.get": identityFileResponses("Main", "1".repeat(64)),
            "agents.update": { ok: true, agentId: "main" },
          },
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        });

        await page.goto(`${suite.server.baseUrl}settings/agents/main/files`);
        await page.locator('[id="agent-files-tab-IDENTITY.md"]').click();
        const editor = page.locator(".agent-file-textarea");
        await expect.poll(() => editor.inputValue()).toBe(identityContent("Main"));

        await page.locator('[id="agents-tab-overview"]').click();
        const identityReadsBeforeSave = (await gateway.getRequests("agents.files.get")).filter(
          (request) => requestName(request) === "IDENTITY.md",
        ).length;
        const nameInput = page.locator(".agent-identity-editor input[type=text]").first();
        await nameInput.fill("Renamed");
        await page
          .locator(".agent-identity-editor")
          .getByRole("button", { name: "Save", exact: true })
          .click();
        const update = await gateway.waitForRequest("agents.update");
        expect(update.params).toMatchObject({ agentId: "main", name: "Renamed" });
        await gateway.setMethodResponse(
          "agent.identity.get",
          identityResponses("local", "Renamed"),
        );
        await gateway.setMethodResponse(
          "agents.files.get",
          identityFileResponses("Renamed", "4".repeat(64)),
        );

        await page.locator('[id="agents-tab-files"]').click();
        await expect.poll(() => editor.inputValue()).toBe(identityContent("Renamed"));
        await expect
          .poll(
            async () =>
              (await gateway.getRequests("agents.files.get")).filter(
                (request) => requestName(request) === "IDENTITY.md",
              ).length,
          )
          .toBeGreaterThan(identityReadsBeforeSave);
        await capture(page, "04-identity-form-refresh.png");
      },
    );
  });
});
