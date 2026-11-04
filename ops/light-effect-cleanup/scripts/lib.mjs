import { spawnSync } from "node:child_process";
// Shared helpers for the light-effect cleanup package.
//
// Everything the package touches is an operator-owned instruction or config
// surface. The phone-notifications plugin itself is not modified: its other
// capabilities (notifications, recordings, images, web pages, ASR, ai_todo)
// stay enabled, while the five light tools are denied by tool policy.
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = join(PACKAGE_DIR, "manifest.json");

export function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export function targetRoot() {
  return process.env.LEC_TARGET_ROOT ? resolve(process.env.LEC_TARGET_ROOT) : "/";
}

export function targetPath(relPath) {
  return join(targetRoot(), relPath);
}

export function backupBase() {
  return (
    process.env.LEC_BACKUP_BASE ??
    join(process.env.HOME ?? "/home/raymond", ".openclaw/backups/light-effect-cleanup")
  );
}

export function openclawBin() {
  return process.env.LEC_OPENCLAW_BIN ?? "openclaw";
}

export function openclawRoot() {
  return process.env.LEC_OPENCLAW_ROOT ?? resolve(PACKAGE_DIR, "..", "..");
}

export function runCli(args, options = {}) {
  const bin = openclawBin();
  const result = spawnSync(bin, args, {
    cwd: openclawRoot(),
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    env: process.env,
  });
  if (result.error) {
    return { ok: false, status: null, stdout: "", stderr: String(result.error.message) };
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function cliJson(args) {
  const result = runCli(args);
  const raw = result.stdout.trim();
  if (!result.ok) {
    return {
      ok: false,
      error: `\`${openclawBin()} ${args.join(" ")}\` exited ${result.status}: ${(result.stderr || raw).trim()}`,
    };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: `\`${openclawBin()} ${args.join(" ")}\` returned non-JSON output` };
  }
  return { ok: true, value };
}

export function cronGet(jobId) {
  return cliJson(["cron", "get", jobId, "--json"]);
}

export function configGet(path) {
  // `config get` exits 1 for a valid-but-unset path and prints a JSON error
  // object, so parse stdout before judging the exit code.
  const result = runCli(["config", "get", path, "--json"]);
  const raw = result.stdout.trim();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: `\`${openclawBin()} config get ${path} --json\` returned non-JSON output: ${(result.stderr || raw).trim()}`,
    };
  }
  if (value && typeof value === "object" && !Array.isArray(value) && value.ok === false) {
    const message = String(value.error?.message ?? "");
    if (result.status === 1 && message.includes("unset")) {
      return { ok: true, unset: true, value: undefined, detail: message };
    }
    return { ok: false, error: message || `config get ${path} failed` };
  }
  if (!result.ok) {
    return {
      ok: false,
      error: `\`${openclawBin()} config get ${path} --json\` exited ${result.status}: ${(result.stderr || raw).trim()}`,
    };
  }
  return { ok: true, unset: false, value };
}

export function countOccurrences(text, needle) {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let from = 0;
  while (true) {
    const at = text.indexOf(needle, from);
    if (at < 0) {
      return count;
    }
    count += 1;
    from = at + needle.length;
  }
}

// Applies the manifest ops to a text. The same function drives live deploys and
// idempotency checks, so an already-clean file reports changed=false without
// pretending an unapplied patch was found.
export function applyOps(text, ops) {
  let next = text;
  const applied = [];
  const errors = [];
  for (const [index, op] of ops.entries()) {
    const label = `op#${index + 1} ${op.type}`;
    if (op.type === "replace") {
      const found = countOccurrences(next, op.old);
      if (found > 0) {
        const expected = op.count ?? 1;
        if (found !== expected) {
          errors.push(`${label}: expected ${expected} occurrence(s), found ${found}`);
          continue;
        }
        next = next.split(op.old).join(op.new);
        applied.push(`${label}: replaced ${found}`);
        continue;
      }
      if (op.new && next.includes(op.new)) {
        applied.push(`${label}: already applied`);
        continue;
      }
      errors.push(`${label}: target text not found and replacement not present`);
      continue;
    }
    if (op.type === "removeSection") {
      const startAt = next.indexOf(op.start);
      if (startAt >= 0) {
        const endAt = next.indexOf(op.end, startAt + op.start.length);
        if (endAt < 0) {
          errors.push(`${label}: start marker found but end marker "${op.end}" missing`);
          continue;
        }
        next = next.slice(0, startAt) + next.slice(endAt);
        applied.push(`${label}: removed section`);
        continue;
      }
      if (next.includes(op.end)) {
        applied.push(`${label}: already applied`);
        continue;
      }
      errors.push(`${label}: section start "${op.start}" not found`);
      continue;
    }
    errors.push(`${label}: unknown op type "${op.type}"`);
  }
  return { text: next, changed: next !== text, applied, errors };
}

export function readText(path) {
  return readFileSync(path, "utf8");
}

export function fileMode(path) {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o644;
  }
}

// Writes through a sibling temp file so a crash cannot leave a half-written
// instruction file behind. Preserves the original mode (dingtalk-notify.mjs is
// executable-adjacent 0664).
export function writeTextAtomic(path, text, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.lec-tmp-${process.pid}`;
  writeFileSync(temp, text, "utf8");
  chmodSync(temp, mode);
  renameSync(temp, path);
}

export function backupFile(path, backupDir, index) {
  if (!existsSync(path)) {
    return null;
  }
  const name = `${String(index).padStart(2, "0")}-${path.split("/").pop()}`;
  const dest = join(backupDir, "files", name);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(path, dest);
  return { name, mode: fileMode(path) };
}

export function restoreFile(backupDir, entry, path) {
  const src = join(backupDir, "files", entry.name);
  if (!existsSync(src)) {
    throw new Error(`backup file missing: ${src}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.lec-restore-${process.pid}`;
  copyFileSync(src, temp);
  chmodSync(temp, entry.mode ?? 0o644);
  renameSync(temp, path);
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function removeIfExists(path) {
  rmSync(path, { force: true });
}

export function fmtList(list) {
  return Array.isArray(list) && list.length > 0 ? list.join(", ") : "(none)";
}
