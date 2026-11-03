// Control UI tests prove the Experience section against a deterministic mocked Gateway.
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SkillExperienceRecord } from "../lib/skill-workshop/experience.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createSkillWorkshopExperienceFixture,
  experiencePromoteResult,
} from "../test-helpers/skill-workshop-experience-fixture.ts";

let browser: Browser;
let server: ControlUiE2eServer;

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());

function manifestWith(records: SkillExperienceRecord[]) {
  return {
    schema: "openclaw.skill-workshop.experiences-manifest.v1",
    updatedAt: "2026-11-03T11:00:00.000Z",
    experiences: records,
    counts: {
      active: records.filter((record) => record.status === "active").length,
      promoted: records.filter((record) => record.status === "promoted").length,
      retired: records.filter((record) => record.status === "retired").length,
    },
  };
}

async function openExperience(page: Page) {
  await page.goto(`${server.baseUrl}skills/workshop`);
  await page.locator("#skill-workshop-mode-tab-experience").click();
  await page.locator(".sw-experience__row").first().waitFor();
}

function editedRecord(record: SkillExperienceRecord): SkillExperienceRecord {
  return {
    ...record,
    description: "Check the saved rollback path and the published asset hash.",
    updatedAt: "2026-11-03T11:30:00.000Z",
    revisionHash: "a1".padEnd(64, "0"),
  };
}

function retiredRecord(record: SkillExperienceRecord): SkillExperienceRecord {
  return {
    ...record,
    status: "retired",
    retiredAt: "2026-11-03T12:00:00.000Z",
    retireReason: "Superseded by the deployment skill.",
    updatedAt: "2026-11-03T12:00:00.000Z",
    revisionHash: "a2".padEnd(64, "0"),
  };
}

describe("Skill Workshop Experience mocked Gateway E2E", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("lists candidates, reads evidence and long documents, and never claims usage", async () => {
    const fixture = createSkillWorkshopExperienceFixture();
    const artifacts = createControlUiE2eArtifactDir("workshop-experience-list");
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifacts, size: { width: 1280, height: 900 } },
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [...defaultControlUiFeatureMethods, ...fixture.featureMethods],
      methodResponses: fixture.responses,
    });
    try {
      await page.goto(`${server.baseUrl}skills/workshop`);
      await page.locator(".sw-collection__shelf").waitFor();
      await page.screenshot({ path: path.join(artifacts, "01-before-skills.png") });
      await page.locator("#skill-workshop-mode-tab-suggestions").click();
      await page.screenshot({ path: path.join(artifacts, "02-before-suggestions.png") });

      await page.locator("#skill-workshop-mode-tab-experience").click();
      const listRequest = await gateway.waitForRequest("skills.experience.list");
      expect(listRequest.params).toEqual({ agentId: "main" });
      const rows = page.locator(".sw-experience__row");
      await expect.poll(async () => rows.count()).toBe(3);
      expect(await rows.allTextContents()).toEqual([
        expect.stringContaining("incident-triage-runbook"),
        expect.stringContaining("release-rollback-check"),
        expect.stringContaining("proxy-header-recovery"),
      ]);
      const chips = page.locator(".sw-experience__chip");
      expect((await chips.allTextContents()).map((text) => text.replace(/\s+/g, ""))).toEqual([
        "Candidate3",
        "Promoted1",
        "Retired1",
      ]);

      await rows.filter({ hasText: "release-rollback-check" }).click();
      const readRequest = await gateway.waitForRequest("skills.experience.read", {
        match: { id: "release-rollback-check" },
      });
      expect(readRequest.params).toEqual({ agentId: "main", id: "release-rollback-check" });
      const detail = page.locator(".sw-experience__detail");
      await detail.getByText("Observed", { exact: true }).waitFor();
      await detail
        .getByText("The saved rollback command restored the previous build in a dry run.")
        .waitFor();
      await detail.getByRole("heading", { name: "Release rollback check" }).waitFor();
      await detail.getByRole("button", { name: "Open session" }).waitFor();
      await page.screenshot({ path: path.join(artifacts, "03-after-experience-detail.png") });

      const search = page.getByRole("searchbox", { name: "Search experiences" });
      await search.fill("proxy");
      await expect.poll(async () => rows.count()).toBe(1);
      await search.fill("no-such-experience");
      await page.getByText("No experiences match that search").waitFor();
      await page.getByRole("button", { name: "Clear search" }).click();

      await page.locator(".sw-experience__chip", { hasText: "Retired" }).click();
      await expect.poll(async () => rows.count()).toBe(1);
      await rows.first().click();
      await detail.getByRole("button", { name: "Restore" }).waitFor();
      expect(await detail.getByRole("button", { name: "Edit" }).count()).toBe(0);
      expect(await detail.getByRole("button", { name: "Promote to skill" }).count()).toBe(0);

      await page.locator(".sw-experience__chip", { hasText: "Candidate" }).click();
      await page.getByRole("searchbox", { name: "Search experiences" }).fill("incident");
      await rows.first().click();
      const longReader = page.locator(".sw-experience__detail .sidebar-markdown");
      await expect.poll(async () => longReader.locator("li").count()).toBeGreaterThan(300);
      await longReader
        .getByText("Confirm triage step 0420 and record the observed result.")
        .waitFor();

      const body = await page.locator("body").textContent();
      expect((body ?? "").toLowerCase()).not.toContain("unused");
      expect((body ?? "").toLowerCase()).not.toContain("usage");
      await page.screenshot({ path: path.join(artifacts, "04-after-long-document.png") });
    } finally {
      await context.close();
    }
  });

  it("saves an edit and keeps the draft when the revision changed", async () => {
    const fixture = createSkillWorkshopExperienceFixture();
    const artifacts = createControlUiE2eArtifactDir("workshop-experience-edit-conflict");
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifacts, size: { width: 1280, height: 900 } },
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [...defaultControlUiFeatureMethods, ...fixture.featureMethods],
      methodResponses: fixture.responses,
    });
    try {
      await openExperience(page);
      await page.locator(".sw-experience__row", { hasText: "release-rollback-check" }).click();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      const dialog = page.locator("openclaw-modal-dialog .sw-experience-dialog");
      await dialog.waitFor();
      const summary = dialog.getByLabel("Summary");
      await summary.fill("Check the saved rollback path and the published asset hash.");
      const body = dialog.getByLabel("Document");
      await body.fill(`${await body.inputValue()}\n\nRecord the published asset hash.\n`);

      const original = fixture.records.find((record) => record.id === "release-rollback-check")!;
      const updated = editedRecord(original);
      await gateway.setMethodResponse(
        "skills.experience.list",
        manifestWith([updated, ...fixture.records.filter((record) => record.id !== original.id)]),
      );
      const updateCount = (await gateway.getRequests("skills.experience.update")).length;
      await gateway.deferNext("skills.experience.update");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      const updateRequest = await gateway.waitForRequest("skills.experience.update", {
        after: updateCount,
      });
      expect(updateRequest.params).toMatchObject({
        agentId: "main",
        id: "release-rollback-check",
        expectedRevisionHash: original.revisionHash,
        description: "Check the saved rollback path and the published asset hash.",
      });
      expect(String((updateRequest.params as { content?: string }).content)).toContain(
        "Record the published asset hash.",
      );
      await gateway.resolveDeferred("skills.experience.update", {
        record: updated,
        revisionHash: updated.revisionHash,
      });
      await expect.poll(async () => page.locator("openclaw-modal-dialog").count()).toBe(0);
      await page
        .getByText("Check the saved rollback path and the published asset hash.")
        .first()
        .waitFor();
      await page.screenshot({ path: path.join(artifacts, "01-saved-edit.png") });

      await page.getByRole("button", { name: "Edit", exact: true }).click();
      const conflictDialog = page.locator("openclaw-modal-dialog .sw-experience-dialog");
      await conflictDialog.waitFor();
      await conflictDialog.getByLabel("Document").fill("# Kept draft\n\nThis text must survive.");
      const conflictCount = (await gateway.getRequests("skills.experience.update")).length;
      await gateway.deferNext("skills.experience.update");
      await conflictDialog.getByRole("button", { name: "Save", exact: true }).click();
      await gateway.waitForRequest("skills.experience.update", { after: conflictCount });
      await gateway.rejectDeferred("skills.experience.update", {
        code: "INVALID_REQUEST",
        message: "The experience changed; reload it before retrying.",
        details: {
          code: "SKILL_EXPERIENCE_REVISION_CHANGED",
          expectedRevisionHash: updated.revisionHash,
          currentRevisionHash: original.revisionHash,
        },
      });
      await conflictDialog.getByText("This experience changed in another session").waitFor();
      expect(await conflictDialog.getByLabel("Document").inputValue()).toBe(
        "# Kept draft\n\nThis text must survive.",
      );
      const readCount = (
        await gateway.getRequests("skills.experience.read", { id: "release-rollback-check" })
      ).length;
      await conflictDialog.getByRole("button", { name: "Reload latest" }).click();
      await gateway.waitForRequest("skills.experience.read", {
        after: readCount,
        match: { id: "release-rollback-check" },
      });
      await conflictDialog
        .getByText("The latest version is loaded. Your draft was kept; save again to replace it.")
        .waitFor();
      expect(await conflictDialog.getByLabel("Document").inputValue()).toBe(
        "# Kept draft\n\nThis text must survive.",
      );
      expect(
        await conflictDialog.getByRole("button", { name: "Save", exact: true }).isEnabled(),
      ).toBe(true);
      await page.screenshot({ path: path.join(artifacts, "02-conflict-kept-draft.png") });
    } finally {
      await context.close();
    }
  });

  it("promotes into a draft suggestion and opens it for review", async () => {
    const fixture = createSkillWorkshopExperienceFixture();
    const artifacts = createControlUiE2eArtifactDir("workshop-experience-promote");
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifacts, size: { width: 1280, height: 900 } },
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [...defaultControlUiFeatureMethods, ...fixture.featureMethods],
      methodResponses: fixture.responses,
    });
    try {
      await openExperience(page);
      const colliding = fixture.records.find((record) => record.id === "release-rollback-check")!;
      await page.locator(".sw-experience__row", { hasText: "release-rollback-check" }).click();
      await page.getByRole("button", { name: "Promote to skill" }).click();
      const dialog = page.locator("openclaw-modal-dialog .sw-experience-dialog");
      await dialog.waitFor();
      await dialog
        .locator(".sw-experience__fixed-target")
        .getByText(colliding.name, { exact: true })
        .waitFor();
      expect(await dialog.getByLabel("Skill name").count()).toBe(0);
      await dialog.getByText(`A skill named ${colliding.name} already exists.`).waitFor();
      expect(
        await dialog.getByRole("button", { name: "Create draft suggestion" }).isDisabled(),
      ).toBe(true);
      await dialog.getByRole("button", { name: `Update ${colliding.name} instead` }).click();
      expect(
        await dialog.getByRole("radio", { name: "Update an existing skill" }).isChecked(),
      ).toBe(true);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

      const original = fixture.records.find((record) => record.id === "proxy-header-recovery")!;
      await page.locator(".sw-experience__row", { hasText: "proxy-header-recovery" }).click();
      await page.getByRole("button", { name: "Promote to skill" }).click();
      const createDialog = page.locator("openclaw-modal-dialog .sw-experience-dialog");
      await createDialog.waitFor();
      await createDialog
        .locator(".sw-experience__fixed-target")
        .getByText(original.name, { exact: true })
        .waitFor();
      await createDialog.getByLabel("Skill description").fill("Proxy recovery before retrying.");
      const promoteResult = experiencePromoteResult({
        ...original,
        description: "Proxy recovery before retrying.",
      });
      const promotedRecord = promoteResult.record;
      const proposalId = promoteResult.proposal.id;
      const pendingProposal = {
        id: proposalId,
        kind: "create",
        status: "pending",
        title: `Promote ${original.name}`,
        description: "Proxy recovery before retrying.",
        skillName: original.name,
        skillKey: original.name,
        createdAt: "2026-11-03T11:00:00.000Z",
        updatedAt: "2026-11-03T11:00:00.000Z",
        scanState: "clean",
      };
      await gateway.setMethodResponse("skills.proposals.list", {
        ...fixture.proposalsManifest,
        proposals: [pendingProposal, ...fixture.proposalsManifest.proposals],
      });
      await gateway.setMethodResponse("skills.proposals.inspect", {
        cases: [
          {
            match: { proposalId },
            response: {
              record: promoteResult.proposal,
              revisionHash: "d".repeat(64),
              content: `# ${original.name}`,
              supportFiles: [],
            },
          },
        ],
      });
      await gateway.setMethodResponse(
        "skills.experience.list",
        manifestWith([
          promotedRecord,
          ...fixture.records.filter((record) => record.id !== original.id),
        ]),
      );
      const readFixture = fixture.responses["skills.experience.read"];
      await gateway.setMethodResponse("skills.experience.read", {
        cases: readFixture.cases.map((entry) =>
          entry.match.id === promotedRecord.id
            ? {
                match: entry.match,
                response: {
                  record: promotedRecord,
                  revisionHash: promotedRecord.revisionHash,
                  content: entry.response.content,
                },
              }
            : entry,
        ),
      });
      const promoteCount = (await gateway.getRequests("skills.experience.promote")).length;
      await gateway.deferNext("skills.experience.promote");
      await createDialog.getByRole("button", { name: "Create draft suggestion" }).click();
      const promoteRequest = await gateway.waitForRequest("skills.experience.promote", {
        after: promoteCount,
      });
      expect(promoteRequest.params).toMatchObject({
        agentId: "main",
        id: original.id,
        expectedRevisionHash: original.revisionHash,
        target: {
          kind: "create",
          name: original.name,
          description: "Proxy recovery before retrying.",
        },
      });
      await gateway.resolveDeferred("skills.experience.promote", promoteResult);
      await page.locator("#skill-workshop-mode-tab-suggestions[active]").waitFor();
      await gateway.waitForRequest("skills.proposals.inspect", {
        match: { proposalId },
      });
      await page.getByText("Draft suggestion created. Review it in Suggestions.").waitFor();
      await page.screenshot({ path: path.join(artifacts, "01-promoted-into-suggestions.png") });

      await page.locator("#skill-workshop-mode-tab-experience").click();
      const promotedChip = page.locator(".sw-experience__chip", { hasText: "Promoted" });
      await expect.poll(async () => promotedChip.getAttribute("aria-pressed")).toBe("true");
      await page.getByText(`Promotion pending review for ${original.name}`).first().waitFor();
    } finally {
      await context.close();
    }
  });

  it("retires and restores an experience", async () => {
    const fixture = createSkillWorkshopExperienceFixture();
    const artifacts = createControlUiE2eArtifactDir("workshop-experience-retire");
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifacts, size: { width: 1280, height: 900 } },
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [...defaultControlUiFeatureMethods, ...fixture.featureMethods],
      methodResponses: fixture.responses,
    });
    try {
      await openExperience(page);
      const original = fixture.records.find((record) => record.id === "release-rollback-check")!;
      const retired = retiredRecord(original);
      await page.locator(".sw-experience__row", { hasText: "release-rollback-check" }).click();
      await page.getByRole("button", { name: "Retire", exact: true }).click();
      const dialog = page.locator("openclaw-modal-dialog .sw-experience-dialog");
      await dialog.waitFor();
      await dialog.getByLabel("Reason (optional)").fill("Superseded by the deployment skill.");
      await gateway.setMethodResponse(
        "skills.experience.list",
        manifestWith([retired, ...fixture.records.filter((record) => record.id !== original.id)]),
      );
      const retireCount = (await gateway.getRequests("skills.experience.retire")).length;
      await gateway.deferNext("skills.experience.retire");
      await dialog.getByRole("button", { name: "Retire experience" }).click();
      const retireRequest = await gateway.waitForRequest("skills.experience.retire", {
        after: retireCount,
      });
      expect(retireRequest.params).toMatchObject({
        agentId: "main",
        id: "release-rollback-check",
        expectedRevisionHash: original.revisionHash,
        reason: "Superseded by the deployment skill.",
      });
      await gateway.resolveDeferred("skills.experience.retire", {
        record: retired,
        revisionHash: retired.revisionHash,
      });
      await expect.poll(async () => page.locator("openclaw-modal-dialog").count()).toBe(0);
      const rows = page.locator(".sw-experience__row");
      await expect.poll(async () => rows.count()).toBe(2);
      expect(await rows.allTextContents()).toEqual([
        expect.stringContaining("incident-triage-runbook"),
        expect.stringContaining("proxy-header-recovery"),
      ]);
      await page.locator(".sw-experience__chip", { hasText: "Retired" }).click();
      await expect.poll(async () => rows.count()).toBe(2);
      await rows.filter({ hasText: "release-rollback-check" }).click();
      const restored = {
        ...original,
        updatedAt: "2026-11-03T12:30:00.000Z",
        revisionHash: "a3".padEnd(64, "0"),
      };
      await gateway.setMethodResponse(
        "skills.experience.list",
        manifestWith([restored, ...fixture.records.filter((record) => record.id !== original.id)]),
      );
      const restoreCount = (await gateway.getRequests("skills.experience.restore")).length;
      await gateway.deferNext("skills.experience.restore");
      await page.getByRole("button", { name: "Restore", exact: true }).click();
      const restoreRequest = await gateway.waitForRequest("skills.experience.restore", {
        after: restoreCount,
      });
      expect(restoreRequest.params).toMatchObject({
        agentId: "main",
        id: "release-rollback-check",
      });
      await gateway.resolveDeferred("skills.experience.restore", {
        record: restored,
        revisionHash: restored.revisionHash,
      });
      await page.getByText("Experience restored").waitFor();
      const candidateChip = page.locator(".sw-experience__chip", { hasText: "Candidate" });
      await expect
        .poll(async () => (await candidateChip.textContent())?.replace(/\s+/g, ""))
        .toBe("Candidate3");
      await page.screenshot({ path: path.join(artifacts, "01-restored-candidate.png") });

      const promoted = fixture.records.find((record) => record.id === "flaky-e2e-quarantine")!;
      const activeRecords = [
        restored,
        ...fixture.records.filter((record) => record.id !== original.id),
      ];
      const retiredPromoted = {
        ...promoted,
        status: "retired" as const,
        retiredAt: "2026-11-03T13:00:00.000Z",
        retireReason: "Kept for history.",
        updatedAt: "2026-11-03T13:00:00.000Z",
        revisionHash: "b4".padEnd(64, "0"),
      };
      await page.locator(".sw-experience__chip", { hasText: "Promoted" }).click();
      await rows.filter({ hasText: promoted.name }).click();
      await page.getByRole("button", { name: "Retire", exact: true }).click();
      const promotedRetireDialog = page.locator("openclaw-modal-dialog .sw-experience-dialog");
      await promotedRetireDialog.waitFor();
      await promotedRetireDialog.getByLabel("Reason (optional)").fill("Kept for history.");
      await gateway.setMethodResponse(
        "skills.experience.list",
        manifestWith(
          activeRecords.map((record) => (record.id === promoted.id ? retiredPromoted : record)),
        ),
      );
      const promotedRetireCount = (await gateway.getRequests("skills.experience.retire")).length;
      await gateway.deferNext("skills.experience.retire");
      await promotedRetireDialog.getByRole("button", { name: "Retire experience" }).click();
      await gateway.waitForRequest("skills.experience.retire", {
        after: promotedRetireCount,
      });
      await gateway.resolveDeferred("skills.experience.retire", {
        record: retiredPromoted,
        revisionHash: retiredPromoted.revisionHash,
      });
      await expect.poll(async () => page.locator("openclaw-modal-dialog").count()).toBe(0);
      await page.locator(".sw-experience__chip", { hasText: "Retired" }).click();
      await rows.filter({ hasText: promoted.name }).click();

      const failedRestoreCount = (await gateway.getRequests("skills.experience.restore")).length;
      await gateway.deferNext("skills.experience.restore");
      await page.getByRole("button", { name: "Restore", exact: true }).click();
      await gateway.waitForRequest("skills.experience.restore", { after: failedRestoreCount });
      await gateway.rejectDeferred("skills.experience.restore", {
        code: "UNAVAILABLE",
        message: "Restore failed in the mock.",
      });
      await page.getByText("Restore failed in the mock.").waitFor();
      expect(await page.getByRole("button", { name: "Restore", exact: true }).isEnabled()).toBe(
        true,
      );

      const restoredPromoted = {
        ...promoted,
        updatedAt: "2026-11-03T13:30:00.000Z",
        revisionHash: "b5".padEnd(64, "0"),
      };
      await gateway.setMethodResponse(
        "skills.experience.list",
        manifestWith(
          activeRecords.map((record) => (record.id === promoted.id ? restoredPromoted : record)),
        ),
      );
      const promotedRestoreCount = (await gateway.getRequests("skills.experience.restore")).length;
      await gateway.deferNext("skills.experience.restore");
      await page.getByRole("button", { name: "Restore", exact: true }).click();
      await gateway.waitForRequest("skills.experience.restore", {
        after: promotedRestoreCount,
      });
      await gateway.resolveDeferred("skills.experience.restore", {
        record: restoredPromoted,
        revisionHash: restoredPromoted.revisionHash,
      });
      const promotedChip = page.locator(".sw-experience__chip", { hasText: "Promoted" });
      await expect.poll(async () => promotedChip.getAttribute("aria-pressed")).toBe("true");
      await page.getByText(`Promotion pending review for ${promoted.name}`).first().waitFor();
      await page.screenshot({ path: path.join(artifacts, "02-restored-promoted.png") });
    } finally {
      await context.close();
    }
  });

  it("lets a read-only operator read experiences without write actions", async () => {
    const fixture = createSkillWorkshopExperienceFixture();
    const artifacts = createControlUiE2eArtifactDir("workshop-experience-permission");
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifacts, size: { width: 1280, height: 900 } },
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [...defaultControlUiFeatureMethods, ...fixture.featureMethods],
      methodResponses: fixture.responses,
      operatorScopes: ["operator.read"],
    });
    try {
      await openExperience(page);
      await page.locator(".sw-experience__row", { hasText: "release-rollback-check" }).click();
      const detail = page.locator(".sw-experience__detail");
      await detail.getByRole("heading", { name: "Release rollback check" }).waitFor();
      for (const name of ["Edit", "Promote to skill", "Retire"]) {
        const button = detail.getByRole("button", { name, exact: true });
        await expect.poll(async () => button.isDisabled()).toBe(true);
      }
      await detail
        .getByText("Your operator role can view experiences but not change them.")
        .first()
        .waitFor();
      expect(
        await page.getByRole("button", { name: "New experience", exact: true }).isDisabled(),
      ).toBe(true);
      expect(await gateway.getRequests("skills.experience.update")).toHaveLength(0);
      await page.screenshot({ path: path.join(artifacts, "01-read-only.png") });
    } finally {
      await context.close();
    }
  });

  it("stacks the experience panes at 390 px", async () => {
    const fixture = createSkillWorkshopExperienceFixture();
    const artifacts = createControlUiE2eArtifactDir("workshop-experience-mobile");
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifacts, size: { width: 390, height: 844 } },
      serviceWorkers: "block",
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: [...defaultControlUiFeatureMethods, ...fixture.featureMethods],
      methodResponses: fixture.responses,
    });
    try {
      await openExperience(page);
      await page.locator(".sw-experience__row", { hasText: "release-rollback-check" }).click();
      await page
        .locator(".sw-experience__detail")
        .getByRole("heading", { name: "Release rollback check" })
        .waitFor();
      const geometry = await page.evaluate(() => {
        const list = document.querySelector(".sw-experience__list")!.getBoundingClientRect();
        const detail = document.querySelector(".sw-experience__detail")!.getBoundingClientRect();
        return { listBottom: list.bottom, detailTop: detail.top, detailWidth: detail.width };
      });
      expect(geometry.detailTop).toBeGreaterThanOrEqual(geometry.listBottom - 1);
      expect(geometry.detailWidth).toBeLessThanOrEqual(390);
      await page.screenshot({ path: path.join(artifacts, "01-mobile-390.png") });
    } finally {
      await context.close();
    }
  });
});
