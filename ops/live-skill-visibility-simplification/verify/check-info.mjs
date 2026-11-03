#!/usr/bin/env node
// Checks `openclaw skills info --json` before/after one target's frontmatter edit.

import { readFileSync } from "node:fs";

function die(message) {
  console.error(`check-info: ${message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const opts = { names: [], beforeDir: "", afterDir: "" };
for (let i = 0; i < args.length; i += 1) {
  switch (args[i]) {
    case "--name":
      opts.names.push(args[++i] ?? "");
      break;
    case "--before-dir":
      opts.beforeDir = args[++i] ?? "";
      break;
    case "--after-dir":
      opts.afterDir = args[++i] ?? "";
      break;
    default:
      die(`unknown argument: ${args[i]}`);
  }
}
if (opts.names.length === 0) die("at least one --name is required");
if (!opts.beforeDir || !opts.afterDir) die("--before-dir and --after-dir are required");

let passes = 0;
let failures = 0;
function pass(message) {
  passes += 1;
  console.log(`PASS info: ${message}`);
}
function fail(message) {
  failures += 1;
  console.log(`FAIL info: ${message}`);
}

for (const name of opts.names) {
  let before;
  let after;
  try {
    before = JSON.parse(readFileSync(`${opts.beforeDir}/info-before-${name}.json`, "utf8"));
    after = JSON.parse(readFileSync(`${opts.afterDir}/info-after-${name}.json`, "utf8"));
  } catch (error) {
    fail(`${name}: cannot read info snapshots (${error.message})`);
    continue;
  }
  if (after.name !== name) fail(`${name}: info name is ${after.name}`);
  else pass(`${name}: info name matches`);
  if (after.eligible === true) pass(`${name}: eligible remains true`);
  else fail(`${name}: eligible is ${after.eligible}, expected true`);
  if (after.modelVisible === false) pass(`${name}: modelVisible is false`);
  else fail(`${name}: modelVisible is ${after.modelVisible}, expected false`);
  if (typeof after.filePath === "string" && after.filePath.length > 0) {
    pass(`${name}: filePath still resolves`);
  } else {
    fail(`${name}: filePath missing`);
  }
  for (const field of ["userInvocable", "commandVisible", "source", "disabled"]) {
    if (before[field] === after[field]) pass(`${name}: ${field} unchanged`);
    else fail(`${name}: ${field} changed ${before[field]} -> ${after[field]}`);
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
