import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  createExperienceFile,
  ExperienceRevisionChangedError,
  listExperienceFiles,
  readExperienceFile,
  restoreExperienceFile,
  retireExperienceFile,
  updateExperienceFile,
} from "./experience-document.js";
import { resolveExperienceRoot, resolveRetiredExperienceRoot } from "./experience-root.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

async function fixture() {
  const stateDir = await tempDirs.make("openclaw-experience-");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const workspaceDir = path.join(stateDir, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  const config: OpenClawConfig = { agents: { entries: { main: { agentDir } } } };
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  return { stateDir, agentDir, workspaceDir, config, env };
}

describe("Experience documents", () => {
  it("creates an agent-private EXPERIENCE.md and reads it back without frontmatter", async () => {
    const { config, env } = await fixture();
    const created = await createExperienceFile({
      config,
      agentId: "main",
      env,
      name: "Draft release notes",
      description: "How this agent drafts release notes before review.",
      content: "# Draft release notes\n\n1. Collect merged changes.\n",
      tags: ["release", "writing"],
      capture: "manual",
      evidence: { verification: "observed", summary: "Used twice in this workspace." },
    });

    expect(created.id).toBe("draft-release-notes");
    const filePath = path.join(
      resolveExperienceRoot(config, "main", env),
      "draft-release-notes",
      "EXPERIENCE.md",
    );
    const raw = await fs.readFile(filePath, "utf8");
    expect(raw).toContain('name: "Draft release notes"');
    expect(raw).toContain('tags: "[\\"release\\",\\"writing\\"]"');
    expect(raw.startsWith("---\n")).toBe(true);

    const read = await readExperienceFile({ config, agentId: "main", env, id: created.id });
    expect(read.body).toBe("# Draft release notes\n\n1. Collect merged changes.\n");
    expect(read.metadata.tags).toEqual(["release", "writing"]);
    expect(read.revisionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(read.retired).toBe(false);
  });

  it("keeps a second agent from reading or listing the first agent's documents", async () => {
    const { stateDir, agentDir, config, env } = await fixture();
    await createExperienceFile({
      config,
      agentId: "main",
      env,
      name: "Private note",
      description: "Private to main.",
      content: "Only main may read this.\n",
    });
    const otherAgentDir = path.join(stateDir, "agents", "other", "agent");
    const otherConfig: OpenClawConfig = {
      agents: { entries: { main: { agentDir }, other: { agentDir: otherAgentDir } } },
    };

    await expect(
      readExperienceFile({ config: otherConfig, agentId: "other", env, id: "private-note" }),
    ).rejects.toThrow("Experience not found");
    expect(await listExperienceFiles({ config: otherConfig, agentId: "other", env })).toEqual([]);
  });

  it("rejects duplicate ids, traversal ids, and recognized literal credentials", async () => {
    const { config, env } = await fixture();
    await createExperienceFile({
      config,
      agentId: "main",
      env,
      name: "Existing note",
      description: "Existing.",
      content: "Existing body.\n",
    });

    await expect(
      createExperienceFile({
        config,
        agentId: "main",
        env,
        name: "Existing note",
        description: "Duplicate.",
        content: "Other body.\n",
      }),
    ).rejects.toThrow("already exists");
    await expect(
      readExperienceFile({ config, agentId: "main", env, id: "../escape" }),
    ).rejects.toThrow("Experience id");
    await expect(
      createExperienceFile({
        config,
        agentId: "main",
        env,
        name: "Leaky note",
        description: "Leaky.",
        content: `token: ghp_${"a".repeat(32)}\n`,
      }),
    ).rejects.toThrow("literal credential");
  });

  it("bounds writes by revision hash and preserves operator frontmatter on update", async () => {
    const { config, env } = await fixture();
    const created = await createExperienceFile({
      config,
      agentId: "main",
      env,
      name: "Release checklist",
      description: "Checklist.",
      content: "First draft.\n",
    });
    const filePath = path.join(
      resolveExperienceRoot(config, "main", env),
      created.id,
      "EXPERIENCE.md",
    );
    const raw = await fs.readFile(filePath, "utf8");
    await fs.writeFile(
      filePath,
      raw.replace(/\n---\n\n/u, '\noperator-note: "keep me"\n---\n\n'),
      "utf8",
    );
    const current = await readExperienceFile({ config, agentId: "main", env, id: created.id });

    await expect(
      updateExperienceFile({
        config,
        agentId: "main",
        env,
        id: created.id,
        expectedRevisionHash: created.revisionHash,
        content: "Second draft.\n",
      }),
    ).rejects.toBeInstanceOf(ExperienceRevisionChangedError);

    const updated = await updateExperienceFile({
      config,
      agentId: "main",
      env,
      id: created.id,
      expectedRevisionHash: current.revisionHash,
      description: "Updated checklist.",
      content: "Second draft.\n",
    });
    expect(updated.body).toBe("Second draft.\n");
    expect(updated.metadata.description).toBe("Updated checklist.");
    expect(await fs.readFile(filePath, "utf8")).toContain('operator-note: "keep me"');
  });

  it("rejects credentials in free-text metadata without echoing them", async () => {
    const { config, env } = await fixture();
    const secret = `ghp_${"a".repeat(32)}`;
    const createError = await createExperienceFile({
      config,
      agentId: "main",
      env,
      name: "Evidence note",
      description: "Evidence.",
      content: "Safe body.\n",
      evidence: { verification: "observed", summary: `Observed token ${secret}` },
    }).catch((error: unknown) => error as Error);
    expect(createError).toBeInstanceOf(Error);
    expect((createError as Error).message).toContain("literal credential");
    expect((createError as Error).message).not.toContain(secret);
    expect(await listExperienceFiles({ config, agentId: "main", env })).toEqual([]);

    const created = await createExperienceFile({
      config,
      agentId: "main",
      env,
      name: "Retire note",
      description: "Retire.",
      content: "Safe body.\n",
    });
    await expect(
      retireExperienceFile({
        config,
        agentId: "main",
        env,
        id: created.id,
        expectedRevisionHash: created.revisionHash,
        reason: `Superseded by ${secret}`,
      }),
    ).rejects.toThrow("literal credential");
    expect(
      (await listExperienceFiles({ config, agentId: "main", env })).find(
        (file) => file.id === created.id,
      )?.retired,
    ).toBe(false);
  });

  it("honors a configured larger size limit across read, update, retire, and restore", async () => {
    const { agentDir, env } = await fixture();
    const config: OpenClawConfig = {
      agents: { entries: { main: { agentDir } } },
      skills: { limits: { maxSkillFileBytes: 400_000 } },
    };
    const body = `# Large experience\n\n${"x".repeat(300_000)}\n`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(256_000);

    const created = await createExperienceFile({
      config,
      agentId: "main",
      env,
      name: "Large note",
      description: "Large.",
      content: body,
    });
    const read = await readExperienceFile({ config, agentId: "main", env, id: created.id });
    expect(read.body).toBe(body);

    const updated = await updateExperienceFile({
      config,
      agentId: "main",
      env,
      id: created.id,
      expectedRevisionHash: created.revisionHash,
      content: `${body}More.\n`,
    });
    const retired = await retireExperienceFile({
      config,
      agentId: "main",
      env,
      id: created.id,
      expectedRevisionHash: updated.revisionHash,
    });
    const restored = await restoreExperienceFile({
      config,
      agentId: "main",
      env,
      id: created.id,
      expectedRevisionHash: retired.revisionHash,
    });
    expect(restored.retired).toBe(false);
  });

  it("retires out of discovery and restores without losing the document", async () => {
    const { config, env } = await fixture();
    const created = await createExperienceFile({
      config,
      agentId: "main",
      env,
      name: "Retired note",
      description: "Retire me.",
      content: "Body.\n",
    });

    const retired = await retireExperienceFile({
      config,
      agentId: "main",
      env,
      id: created.id,
      expectedRevisionHash: created.revisionHash,
      reason: "Superseded",
    });
    expect(retired.retired).toBe(true);
    expect(retired.metadata.retireReason).toBe("Superseded");
    await expect(
      fs.stat(path.join(resolveExperienceRoot(config, "main", env), created.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await fs.readFile(
        path.join(resolveRetiredExperienceRoot(config, "main", env), created.id, "EXPERIENCE.md"),
        "utf8",
      ),
    ).toContain("Body.");

    const files = await listExperienceFiles({ config, agentId: "main", env });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ id: created.id, retired: true });

    const restored = await restoreExperienceFile({
      config,
      agentId: "main",
      env,
      id: created.id,
      expectedRevisionHash: retired.revisionHash,
    });
    expect(restored.retired).toBe(false);
    expect(restored.metadata.retireReason).toBeUndefined();
    expect((await listExperienceFiles({ config, agentId: "main", env }))[0]?.retired).toBe(false);
  });

  it("does not discover a document directory that symlinks outside the experience root", async () => {
    const { stateDir, config, env } = await fixture();
    const root = resolveExperienceRoot(config, "main", env);
    const outside = path.join(stateDir, "outside", "escaped");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(
      path.join(outside, "EXPERIENCE.md"),
      '---\nname: "Escaped"\ndescription: "Outside the root."\n---\n\nbody\n',
      "utf8",
    );
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(outside, path.join(root, "escaped"), "dir");

    expect(await listExperienceFiles({ config, agentId: "main", env })).toEqual([]);
    await expect(
      readExperienceFile({ config, agentId: "main", env, id: "escaped" }),
    ).rejects.toThrow("Experience not found");
  });
});
