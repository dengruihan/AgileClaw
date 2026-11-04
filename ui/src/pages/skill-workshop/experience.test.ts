// @vitest-environment node
// Control UI tests cover Experience read fencing against a stale scope.
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createSkillWorkshopExperienceFixture } from "../../test-helpers/skill-workshop-experience-fixture.ts";
import { createFixture } from "../../test-helpers/skill-workshop-proposal-fixture.ts";
import { restoreSkillExperienceFromDetail } from "./experience-actions.ts";
import {
  loadSkillExperiences,
  saveSkillExperienceDraft,
  selectSkillExperience,
} from "./experience.ts";

describe("Skill Workshop experience reads", () => {
  it("keeps a confirmed update when an older list read resolves last", async () => {
    const fixture = createSkillWorkshopExperienceFixture();
    const original = fixture.records.find((record) => record.id === "release-rollback-check")!;
    const updated = {
      ...original,
      description: "New confirmed description",
      updatedAt: "2026-11-03T11:30:00.000Z",
      revisionHash: "f".repeat(64),
    };
    const oldManifest = {
      ...fixture.manifest,
      experiences: [original],
      counts: { active: 1, promoted: 0, retired: 0 },
    };
    const listDeferred = createDeferred<unknown>();
    const { state, context, request } = createFixture({ skillWorkshopMode: "experience" });
    state.skillWorkshopExperiences = [{ ...original, content: "old body", contentLoaded: true }];
    request.mockImplementation(async (method) => {
      if (method === "skills.experience.list") {
        return listDeferred.promise;
      }
      if (method === "skills.experience.update") {
        return { record: updated, revisionHash: updated.revisionHash };
      }
      throw new Error(`unexpected ${method}`);
    });

    const loading = loadSkillExperiences(state, context, { force: true });
    await expect
      .poll(
        async () =>
          request.mock.calls.filter(([method]) => method === "skills.experience.list").length,
      )
      .toBe(1);
    expect(state.skillWorkshopExperienceLoading).toBe(true);

    // The list load owns the first agent-scope bind, which resets experience
    // state; the draft belongs to the operator interaction after that bind.
    state.skillWorkshopExperienceDraft = {
      mode: "edit",
      id: original.id,
      name: original.name,
      description: updated.description,
      content: "new body",
      baseRevisionHash: original.revisionHash,
      saving: false,
      error: null,
      conflictHeld: false,
      notice: null,
    };
    expect(await saveSkillExperienceDraft(state, context)).toBe("saved");
    expect(state.skillWorkshopExperienceLoading).toBe(false);

    listDeferred.resolve(oldManifest);
    await loading;

    expect(state.skillWorkshopExperiences.find((entry) => entry.id === original.id)).toMatchObject({
      description: "New confirmed description",
      revisionHash: updated.revisionHash,
    });
    expect(state.skillWorkshopExperienceLoading).toBe(false);
    expect(state.skillWorkshopExperienceError).toBeNull();
  });

  it("keeps a promoted restore selected when the write response lags the projection", async () => {
    const fixture = createSkillWorkshopExperienceFixture();
    const promoted = fixture.records.find((record) => record.id === "flaky-e2e-quarantine")!;
    const revision = "b5".padEnd(64, "0");
    const retired = {
      ...promoted,
      status: "retired" as const,
      retiredAt: "2026-11-03T13:00:00.000Z",
      retireReason: "Kept for history.",
      updatedAt: "2026-11-03T13:00:00.000Z",
      revisionHash: revision,
    };
    // M43's actual restore write response does not project the proposal owner,
    // so an existing promotion link defaults to rejected/active.
    const writeResponse = {
      ...promoted,
      status: "active" as const,
      promotion: { ...promoted.promotion!, state: "rejected" as const },
      updatedAt: "2026-11-03T13:30:00.000Z",
      revisionHash: revision,
    };
    // The forced list then projects the same revision as promoted/pending.
    const refreshed = {
      ...promoted,
      updatedAt: "2026-11-03T13:30:00.000Z",
      revisionHash: revision,
    };
    const { state, context, request } = createFixture({ skillWorkshopMode: "experience" });
    state.skillWorkshopAgentId = "research";
    state.skillWorkshopExperiences = [{ ...retired, content: "body", contentLoaded: true }];
    state.skillWorkshopExperienceSelectedId = retired.id;
    state.skillWorkshopExperienceFilter = "retired";
    request.mockImplementation(async (method) => {
      if (method === "skills.experience.restore") {
        return { record: writeResponse, revisionHash: revision };
      }
      if (method === "skills.experience.list") {
        return {
          schema: "openclaw.skill-workshop.experiences-manifest.v1",
          updatedAt: "2026-11-03T13:30:00.000Z",
          experiences: [refreshed],
          counts: { active: 0, promoted: 1, retired: 0 },
        };
      }
      if (method === "skills.experience.read") {
        return { record: refreshed, revisionHash: revision, content: "body" };
      }
      throw new Error(`unexpected ${method}`);
    });

    await restoreSkillExperienceFromDetail(state, context, retired.id, {
      isCurrent: () => true,
      onProgress: () => undefined,
    });

    expect(state.skillWorkshopExperienceFilter).toBe("promoted");
    expect(state.skillWorkshopExperienceSelectedId).toBe(retired.id);
    expect(state.skillWorkshopExperiences.find((entry) => entry.id === retired.id)).toMatchObject({
      status: "promoted",
      promotion: { state: "pending" },
    });
  });

  it("keeps the newer selection when an earlier read resolves last", async () => {
    const fixture = createSkillWorkshopExperienceFixture();
    const release = fixture.records.find((record) => record.id === "release-rollback-check")!;
    const proxy = fixture.records.find((record) => record.id === "proxy-header-recovery")!;
    const manifest = {
      ...fixture.manifest,
      experiences: [release, proxy],
      counts: { active: 2, promoted: 0, retired: 0 },
    };
    const slow = createDeferred<unknown>();
    const { state, context, request } = createFixture();
    request.mockImplementation(async (method, payload) => {
      if (method === "skills.experience.list") {
        return manifest;
      }
      const id = (payload as { id: string }).id;
      if (id === release.id) {
        return slow.promise;
      }
      const record = fixture.records.find((entry) => entry.id === id)!;
      return {
        record,
        revisionHash: record.revisionHash,
        content: fixture.contents[id] ?? "",
      };
    });

    const loading = loadSkillExperiences(state, context, { force: true });
    await expect
      .poll(
        async () =>
          request.mock.calls.filter(([method]) => method === "skills.experience.read").length,
      )
      .toBe(1);

    await selectSkillExperience(state, context, proxy.id);
    expect(state.skillWorkshopExperienceSelectedId).toBe(proxy.id);

    slow.resolve({
      record: release,
      revisionHash: release.revisionHash,
      content: fixture.contents[release.id] ?? "",
    });
    await loading;

    expect(state.skillWorkshopExperienceSelectedId).toBe(proxy.id);
    expect(state.skillWorkshopExperienceError).toBeNull();
    expect(state.skillWorkshopExperiences.find((entry) => entry.id === release.id)).toMatchObject({
      contentLoaded: true,
    });
  });
});
