import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, readlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("..", import.meta.url));
// Environment overrides let the isolated backup regression run without touching
// the real installation, database, or Gateway.
export const installRoot =
  process.env.AGENDA_INSTALL_ROOT ?? path.join(os.homedir(), ".openclaw", "extensions", "agenda");
export const backupRoot =
  process.env.AGENDA_BACKUP_ROOT ??
  path.join(os.homedir(), ".openclaw", "backups", "agenda-desktop-day-view");
export const databasePath =
  process.env.AGENDA_DATABASE_PATH ??
  path.join(os.homedir(), ".openclaw", "plugins", "agenda", "agenda.sqlite");
export const liveOrigin = process.env.AGENDA_LIVE_ORIGIN ?? "http://127.0.0.1:18810";
export const managedEntries = ["dist", "assets", "skills", "openclaw.plugin.json"];

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

export async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function installedHashes() {
  const recorded = await readJson(path.join(packageRoot, "external", "files.json"));
  const result = {};
  for (const relative of Object.keys(recorded.files)) {
    const file = path.join(installRoot, relative);
    result[relative] = (await exists(file)) ? await sha256File(file) : null;
  }
  return result;
}

export async function sourceFileHashes(source) {
  const recorded = await readJson(path.join(packageRoot, "external", "files.json"));
  const result = {};
  for (const relative of Object.keys(recorded.files)) {
    const file = path.join(source, relative);
    result[relative] = (await exists(file)) ? await sha256File(file) : null;
  }
  return result;
}

export function compareHashes(expected, actual) {
  return Object.entries(expected).map(([relative, hash]) => ({
    file: relative,
    expected: hash,
    actual: actual[relative] ?? null,
    ok: hash === actual[relative],
  }));
}

async function hashPath(absolute) {
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) {
    return { "": `link:${await readlink(absolute)}` };
  }
  if (info.isFile()) {
    return { "": await sha256File(absolute) };
  }
  if (!info.isDirectory()) {
    throw new Error(`unsupported backup entry: ${absolute}`);
  }
  const result = {};
  const walk = async (directory, prefix) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(child, relative);
      } else if (entry.isSymbolicLink()) {
        result[relative] = `link:${await readlink(child)}`;
      } else if (entry.isFile()) {
        result[relative] = await sha256File(child);
      } else {
        throw new Error(`unsupported backup entry: ${child}`);
      }
    }
  };
  await walk(absolute, "");
  return result;
}

export async function hashEntries(root, entries = managedEntries) {
  const result = {};
  for (const entry of entries) {
    const hashes = await hashPath(path.join(root, entry));
    for (const [relative, hash] of Object.entries(hashes)) {
      result[`${entry}${relative ? `/${relative}` : ""}`] = hash;
    }
  }
  return result;
}

// Copy every required installation entry, then prove the backup contains the
// same file set and bytes before deploy.mjs is allowed to touch live files.
export async function createVerifiedBackup(sourceRoot, destinationRoot, entries = managedEntries) {
  await ensureDirectory(destinationRoot);
  for (const entry of entries) {
    const from = path.join(sourceRoot, entry);
    if (!(await exists(from))) {
      throw new Error(`required installation entry is missing: ${entry}`);
    }
    await cp(from, path.join(destinationRoot, entry), { recursive: true, force: true });
  }
  const expected = await hashEntries(sourceRoot, entries);
  const actual = await hashEntries(destinationRoot, entries);
  const mismatches = [];
  for (const [relative, hash] of Object.entries(expected)) {
    if (actual[relative] !== hash) mismatches.push(relative);
  }
  for (const relative of Object.keys(actual)) {
    if (!(relative in expected)) mismatches.push(relative);
  }
  if (mismatches.length) {
    throw new Error(`backup verification failed for: ${mismatches.slice(0, 8).join(", ")}`);
  }
  return { entries: entries.length, files: Object.keys(expected).length };
}

export async function liveRevision() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${liveOrigin}/agenda/api/status`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const body = await response.json();
    return { ok: typeof body.revision === "number", revision: body.revision };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

export function sourceCommit(source) {
  try {
    return execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}
