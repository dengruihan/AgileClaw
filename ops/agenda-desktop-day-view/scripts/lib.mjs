import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("..", import.meta.url));
export const installRoot = path.join(os.homedir(), ".openclaw", "extensions", "agenda");
export const backupRoot = path.join(
  os.homedir(),
  ".openclaw",
  "backups",
  "agenda-desktop-day-view",
);
export const databasePath = path.join(
  os.homedir(),
  ".openclaw",
  "plugins",
  "agenda",
  "agenda.sqlite",
);
export const liveOrigin = "http://127.0.0.1:18810";
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
