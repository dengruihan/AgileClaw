#!/usr/bin/env node
// Compares two `openclaw skills list --json` snapshots.
//
// hide:    the named skills must move from visible to hidden, and every other
//          skill's recorded state must stay identical.
// restore: the named skills must return to visible, and the visible count plus
//          every other skill's recorded state must match the pre-deploy snapshot.

import { readFileSync } from "node:fs";

const STATE_FIELDS = [
  "eligible",
  "disabled",
  "blockedByAllowlist",
  "blockedByAgentFilter",
  "modelVisible",
  "userInvocable",
  "commandVisible",
  "source",
];

function die(message) {
  console.error(`compare-catalog: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    before: "",
    after: "",
    mode: "hide",
    targets: [],
    expectedBefore: null,
    expectedAfter: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--before":
        opts.before = argv[++i] ?? "";
        break;
      case "--after":
        opts.after = argv[++i] ?? "";
        break;
      case "--mode":
        opts.mode = argv[++i] ?? "";
        break;
      case "--targets":
        opts.targets = (argv[++i] ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        break;
      case "--expected-before":
        opts.expectedBefore = Number(argv[++i]);
        break;
      case "--expected-after":
        opts.expectedAfter = Number(argv[++i]);
        break;
      default:
        die(`unknown argument: ${argv[i]}`);
    }
  }
  if (!opts.before || !opts.after) die("--before and --after are required");
  if (!["hide", "restore"].includes(opts.mode)) die(`unsupported mode: ${opts.mode}`);
  if (opts.targets.length === 0) die("--targets is required");
  return opts;
}

function readList(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const skills = Array.isArray(parsed) ? parsed : parsed.skills;
  if (!Array.isArray(skills)) die(`${file} has no skills array`);
  const map = new Map();
  for (const skill of skills) {
    if (!skill || typeof skill.name !== "string") die(`${file} has a skill without a name`);
    if (map.has(skill.name)) die(`${file} has duplicate skill name: ${skill.name}`);
    map.set(skill.name, skill);
  }
  return { skills, map };
}

function visibleCount(skills) {
  return skills.filter((skill) => skill.modelVisible === true).length;
}

function stableState(skill) {
  const state = {};
  for (const field of STATE_FIELDS) state[field] = skill[field];
  return JSON.stringify(state);
}

const opts = parseArgs(process.argv.slice(2));
const before = readList(opts.before);
const after = readList(opts.after);
let failures = 0;
let passes = 0;

function pass(message) {
  passes += 1;
  console.log(`PASS catalog: ${message}`);
}

function fail(message) {
  failures += 1;
  console.log(`FAIL catalog: ${message}`);
}

const beforeVisible = visibleCount(before.skills);
const afterVisible = visibleCount(after.skills);
if (opts.expectedBefore !== null && beforeVisible !== opts.expectedBefore) {
  fail(`visible before ${beforeVisible}, expected ${opts.expectedBefore}`);
} else {
  pass(`visible before ${beforeVisible}`);
}

if (opts.mode === "hide") {
  let hiddenNow = 0;
  for (const name of opts.targets) {
    const oldSkill = before.map.get(name);
    const newSkill = after.map.get(name);
    if (!oldSkill) {
      fail(`${name} missing from before snapshot`);
      continue;
    }
    if (!newSkill) {
      fail(`${name} missing from after snapshot`);
      continue;
    }
    if (oldSkill.modelVisible === true && newSkill.modelVisible === false) {
      hiddenNow += 1;
      pass(`${name}: visible -> hidden`);
    } else if (oldSkill.modelVisible === false && newSkill.modelVisible === false) {
      pass(`${name}: already hidden before and after`);
    } else {
      fail(
        `${name}: expected visible -> hidden, got ${oldSkill.modelVisible} -> ${newSkill.modelVisible}`,
      );
    }
    if (newSkill.eligible !== true)
      fail(`${name}: eligible is ${newSkill.eligible}, expected true`);
    else pass(`${name}: still eligible (file readable)`);
  }
  const expectedAfter = beforeVisible - hiddenNow;
  if (afterVisible !== expectedAfter) {
    fail(`visible after ${afterVisible}, expected ${expectedAfter} (${hiddenNow} newly hidden)`);
  } else {
    pass(`visible after ${afterVisible} (${hiddenNow} newly hidden)`);
  }
  if (opts.expectedAfter !== null && afterVisible !== opts.expectedAfter) {
    fail(`visible after ${afterVisible}, expected ${opts.expectedAfter}`);
  }
} else {
  for (const name of opts.targets) {
    const oldSkill = before.map.get(name);
    const newSkill = after.map.get(name);
    if (!newSkill) {
      fail(`${name} missing from after snapshot`);
      continue;
    }
    if (!oldSkill) {
      fail(`${name} missing from before snapshot`);
      continue;
    }
    if (newSkill.modelVisible === oldSkill.modelVisible) {
      pass(`${name}: restored to modelVisible=${newSkill.modelVisible}`);
    } else {
      fail(
        `${name}: modelVisible is ${newSkill.modelVisible}, expected ${oldSkill.modelVisible} from the backup baseline`,
      );
    }
  }
  if (afterVisible !== beforeVisible) {
    fail(`visible after rollback ${afterVisible}, expected ${beforeVisible}`);
  } else {
    pass(`visible count restored to ${beforeVisible}`);
  }
}

const allNames = new Set([...before.map.keys(), ...after.map.keys()]);
for (const name of allNames) {
  if (opts.targets.includes(name)) continue;
  const oldSkill = before.map.get(name);
  const newSkill = after.map.get(name);
  if (!oldSkill || !newSkill) {
    fail(`${name}: skill missing from one snapshot`);
    continue;
  }
  if (stableState(oldSkill) !== stableState(newSkill)) {
    fail(`${name}: unrelated state changed`);
  }
}
if (![...allNames].some((name) => !opts.targets.includes(name))) {
  pass("no unrelated skills to compare");
} else {
  pass("all unrelated skill states unchanged");
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
