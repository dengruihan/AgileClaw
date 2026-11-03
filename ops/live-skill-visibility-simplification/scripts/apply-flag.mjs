#!/usr/bin/env node
// Single owner for the frontmatter edit used by this package.
//
// It inserts exactly one `disable-model-invocation: true` line after the skill
// `name:` line. Everything else in the file stays byte-identical, so body
// instructions (including collector absolute paths) cannot drift.

import { createHash } from "node:crypto";
import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const FLAG_KEY = "disable-model-invocation";
const FLAG_LINE = `${FLAG_KEY}: true`;

function die(message) {
  console.error(`apply-flag: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { action: "check", file: "", name: "", baseline: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--file":
        opts.file = argv[++i] ?? "";
        break;
      case "--name":
        opts.name = argv[++i] ?? "";
        break;
      case "--baseline":
        opts.baseline = argv[++i] ?? "";
        break;
      case "--check":
        opts.action = "check";
        break;
      case "--write":
        opts.action = "write";
        break;
      case "--remove":
        opts.action = "remove";
        break;
      case "--verify-insert-only":
        opts.action = "verify-insert-only";
        break;
      default:
        die(`unknown argument: ${arg}`);
    }
  }
  if (!opts.file) die("--file is required");
  if (opts.action === "verify-insert-only" && !opts.baseline) {
    die("--verify-insert-only requires --baseline");
  }
  return opts;
}

function analyze(content) {
  const crlf = content.includes("\r\n");
  const lines = content.split("\n");
  const bare = (line) => line.replace(/\r$/, "");
  if (bare(lines[0]) !== "---") {
    return { valid: false, reason: "file does not start with a frontmatter delimiter" };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (bare(lines[i]) === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return { valid: false, reason: "frontmatter has no closing delimiter" };
  }

  const nameLines = [];
  const flagLines = [];
  for (let i = 1; i < close; i += 1) {
    if (/^name:\s*/.test(bare(lines[i]))) nameLines.push(i);
    if (/^disable-model-invocation\s*:/.test(bare(lines[i]))) flagLines.push(i);
  }
  if (nameLines.length !== 1) {
    return {
      valid: false,
      reason: `expected exactly one name: line in frontmatter, found ${nameLines.length}`,
    };
  }
  if (flagLines.length > 1) {
    return {
      valid: false,
      reason: `expected at most one ${FLAG_KEY} line, found ${flagLines.length}`,
    };
  }

  const nameValue = bare(lines[nameLines[0]])
    .slice(bare(lines[nameLines[0]]).indexOf(":") + 1)
    .trim();
  const unquotedName = nameValue.replace(/^["']|["']$/g, "");
  const flagValue = flagLines.length > 0 ? bare(lines[flagLines[0]]).split(":")[1].trim() : "";
  return {
    valid: true,
    crlf,
    lines,
    bare,
    close,
    nameLine: nameLines[0],
    flagLine: flagLines[0] ?? -1,
    nameValue: unquotedName,
    flagValue,
    hidden: flagLines.length === 1 && flagValue === "true",
    flagged: flagLines.length === 1,
    body: lines.slice(close + 1).join("\n"),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function insertedContent(parsed) {
  if (parsed.hidden) return { content: parsed.lines.join("\n"), inserted: false };
  if (parsed.flagged) die(`flag exists with non-true value: ${parsed.flagValue}`);
  const next = [...parsed.lines];
  next.splice(parsed.nameLine + 1, 0, `${FLAG_LINE}${parsed.crlf ? "\r" : ""}`);
  return { content: next.join("\n"), inserted: true };
}

function removedContent(parsed) {
  if (!parsed.flagged) return { content: parsed.lines.join("\n"), removed: false };
  const next = [...parsed.lines];
  next.splice(parsed.flagLine, 1);
  return { content: next.join("\n"), removed: true, previousValue: parsed.flagValue };
}

function atomicWrite(file, content) {
  const mode = statSync(file).mode;
  const tmp = join(dirname(file), `.${basename(file)}.m20-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temporary file may not exist; nothing to clean up.
    }
    throw error;
  }
}

function status(parsed, file) {
  if (!parsed.valid) {
    return { file, status: "invalid", reason: parsed.reason };
  }
  if (parsed.flagged && !parsed.hidden) {
    return {
      file,
      name: parsed.nameValue,
      status: "invalid",
      reason: `flag exists with non-true value: ${parsed.flagValue}`,
      bodySha256: sha256(parsed.body),
    };
  }
  return {
    file,
    name: parsed.nameValue,
    status: parsed.hidden ? "hidden" : "visible",
    flagValue: parsed.flagValue || null,
    bodySha256: sha256(parsed.body),
  };
}

const opts = parseArgs(process.argv.slice(2));
const content = readFileSync(opts.file, "utf8");
const parsed = analyze(content);

if (opts.action === "verify-insert-only") {
  if (!parsed.valid) {
    console.log(JSON.stringify({ ok: false, reason: parsed.reason }));
    process.exit(1);
  }
  const baselineContent = readFileSync(opts.baseline, "utf8");
  const baseline = analyze(baselineContent);
  if (!baseline.valid) {
    console.log(JSON.stringify({ ok: false, reason: `baseline invalid: ${baseline.reason}` }));
    process.exit(1);
  }
  if (opts.name && parsed.nameValue !== opts.name) {
    console.log(
      JSON.stringify({ ok: false, reason: `name mismatch: ${parsed.nameValue} != ${opts.name}` }),
    );
    process.exit(1);
  }
  const expected = insertedContent(baseline).content;
  const ok = expected === content;
  console.log(
    JSON.stringify({
      ok,
      expectedSha256: sha256(expected),
      actualSha256: sha256(content),
      bodySha256: sha256(parsed.body),
      baselineBodySha256: sha256(baseline.body),
    }),
  );
  process.exit(ok ? 0 : 1);
}

if (opts.name && parsed.valid && parsed.nameValue !== opts.name) {
  console.log(
    JSON.stringify({
      file: opts.file,
      status: "invalid",
      reason: `name mismatch: ${parsed.nameValue}`,
    }),
  );
  process.exit(1);
}

if (opts.action === "check") {
  const result = status(parsed, opts.file);
  console.log(JSON.stringify(result));
  process.exit(result.status === "invalid" ? 1 : 0);
}

if (opts.action === "write") {
  if (!parsed.valid) {
    console.log(JSON.stringify({ file: opts.file, status: "invalid", reason: parsed.reason }));
    process.exit(1);
  }
  const next = insertedContent(parsed);
  if (next.inserted) atomicWrite(opts.file, next.content);
  const after = analyze(readFileSync(opts.file, "utf8"));
  if (!after.valid || !after.hidden || after.nameValue !== parsed.nameValue) {
    console.log(
      JSON.stringify({ file: opts.file, status: "invalid", reason: "post-write check failed" }),
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      file: opts.file,
      status: next.inserted ? "written" : "already-hidden",
      name: after.nameValue,
      bodySha256: sha256(after.body),
    }),
  );
  process.exit(0);
}

if (opts.action === "remove") {
  if (!parsed.valid) {
    console.log(JSON.stringify({ file: opts.file, status: "invalid", reason: parsed.reason }));
    process.exit(1);
  }
  const next = removedContent(parsed);
  if (next.removed) atomicWrite(opts.file, next.content);
  const after = analyze(readFileSync(opts.file, "utf8"));
  if (!after.valid || after.flagged) {
    console.log(
      JSON.stringify({ file: opts.file, status: "invalid", reason: "post-remove check failed" }),
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      file: opts.file,
      status: next.removed ? "removed" : "already-visible",
      name: after.nameValue,
      bodySha256: sha256(after.body),
    }),
  );
  process.exit(0);
}

die(`unsupported action: ${opts.action}`);
