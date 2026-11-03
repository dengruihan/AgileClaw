// @vitest-environment node
// Control UI tests cover Experience read fencing against a stale scope.
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createSkillWorkshopExperienceFixture } from "../../test-helpers/skill-workshop-experience-fixture.ts";
import { createFixture } from "../../test-helpers/skill-workshop-proposal-fixture.ts";
import {
  invalidateSkillExperienceReads,
  loadSkillExperiences,
  selectSkillExperience,
} from "./experience.ts";

describe("Skill Workshop experience reads", () => {
  it("drops a list result invalidated by a confirmed mutation", async () => {
    const fixture = createSkillWorkshopExperienceFixture();
    const { state, context, request } = createFixture();
    const deferred = createDeferred<unknown>();
    request.mockReturnValueOnce(deferred.promise);

    const load = loadSkillExperiences(state, context, { force: true });
    expect(state.skillWorkshopExperienceLoading).toBe(true);
    invalidateSkillExperienceReads(state);
    deferred.resolve(fixture.manifest);
    await load;

    expect(state.skillWorkshopExperiences).toEqual([]);
    expect(state.skillWorkshopExperienceLoaded).toBe(false);
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
