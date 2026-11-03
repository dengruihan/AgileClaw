// @vitest-environment node
// Control UI tests cover Experience read fencing against a stale scope.
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createSkillWorkshopExperienceFixture } from "../../test-helpers/skill-workshop-experience-fixture.ts";
import { createFixture } from "../../test-helpers/skill-workshop-proposal-fixture.ts";
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
