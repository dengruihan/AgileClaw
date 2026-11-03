import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createVerifiedBackup, hashEntries, managedEntries, sha256File } from "../scripts/lib.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const installedFiles = [
  "dist/index.js",
  "dist/src/sqlite.worker.js",
  "assets/app.js",
  "assets/app.css",
  "assets/index.html",
  "openclaw.plugin.json",
  "skills/agenda/SKILL.md",
];

const writeFileEnsuringParent = async (file, content) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

const makeInstall = async (root) => {
  for (const relative of installedFiles) {
    await writeFileEnsuringParent(path.join(root, relative), `${relative}\n`);
  }
};

test("createVerifiedBackup copies every required entry and proves byte equality", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "agenda-backup-ok-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const install = path.join(temporary, "install");
  const backup = path.join(temporary, "backup");
  await makeInstall(install);
  const summary = await createVerifiedBackup(install, backup);
  assert.equal(summary.entries, managedEntries.length);
  assert.deepEqual(await hashEntries(backup), await hashEntries(install));
});

test("createVerifiedBackup rejects a missing required entry", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "agenda-backup-missing-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const install = path.join(temporary, "install");
  const backup = path.join(temporary, "backup");
  await makeInstall(install);
  await rm(path.join(install, "skills"), { recursive: true, force: true });
  await assert.rejects(
    createVerifiedBackup(install, backup),
    /required installation entry is missing: skills/,
  );
});

test("createVerifiedBackup surfaces a copy collision instead of accepting a partial backup", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "agenda-backup-collision-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const install = path.join(temporary, "install");
  const backup = path.join(temporary, "backup");
  await makeInstall(install);
  await writeFileEnsuringParent(path.join(backup, "skills"), "not a directory");
  await assert.rejects(createVerifiedBackup(install, backup));
});

test("deploy aborts before live mutation when a required backup entry is missing", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "agenda-deploy-failure-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));

  const packageCopy = path.join(temporary, "package");
  await cp(path.join(packageRoot, "scripts"), path.join(packageCopy, "scripts"), {
    recursive: true,
  });
  await cp(path.join(packageRoot, "external"), path.join(packageCopy, "external"), {
    recursive: true,
  });

  const source = path.join(temporary, "source");
  await makeInstall(source);
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", ["-C", source, "config", "user.email", "fixture@example.invalid"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Fixture"]);
  execFileSync("git", ["-C", source, "add", "-A"]);
  execFileSync("git", ["-C", source, "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const hashes = {};
  for (const relative of installedFiles) {
    hashes[relative] = await sha256File(path.join(source, relative));
  }
  await writeFile(
    path.join(packageCopy, "external", "files.json"),
    `${JSON.stringify(
      {
        base: "0000000000000000000000000000000000000000",
        commit,
        tree: "0000000000000000000000000000000000000000",
        files: hashes,
      },
      null,
      2,
    )}\n`,
  );

  const install = path.join(temporary, "install");
  await makeInstall(install);
  await rm(path.join(install, "skills"), { recursive: true, force: true });
  const presentEntries = managedEntries.filter((entry) => entry !== "skills");
  const before = await hashEntries(install, presentEntries);

  const binaryDirectory = path.join(temporary, "bin");
  const marker = path.join(temporary, "openclaw-called");
  const fakeOpenclaw = path.join(binaryDirectory, "openclaw");
  await writeFileEnsuringParent(fakeOpenclaw, `#!/usr/bin/env bash\necho called > "${marker}"\n`);
  await chmod(fakeOpenclaw, 0o755);

  const result = spawnSync(
    process.execPath,
    [path.join(packageCopy, "scripts", "deploy.mjs"), "--source", source, "--yes"],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        AGENDA_INSTALL_ROOT: install,
        AGENDA_BACKUP_ROOT: path.join(temporary, "backups"),
        AGENDA_DATABASE_PATH: path.join(temporary, "agenda.sqlite"),
        AGENDA_LIVE_ORIGIN: "http://127.0.0.1:1",
      },
    },
  );

  assert.notEqual(result.status, 0, "deploy should fail when a required backup entry is missing");
  assert.match(result.stderr, /Backup failed before any live file was changed/);
  assert.match(result.stderr, /required installation entry is missing: skills/);
  assert.deepEqual(await hashEntries(install, presentEntries), before, "install files changed");
  assert.deepEqual(
    (await readdir(install)).filter((name) => name.endsWith(".pre-deploy")),
    [],
    "staging left live backup markers",
  );
  await assert.rejects(readFile(marker), /ENOENT/, "openclaw was called before backup completed");
});
