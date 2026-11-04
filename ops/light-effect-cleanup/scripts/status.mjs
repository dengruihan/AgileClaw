#!/usr/bin/env node
// Read-only status for the light-effect cleanup package.
//
// Prints the state of every touched surface plus the residual vendor-owned
// light capability that this package cannot remove without patching or
// uninstalling the phone-notifications plugin.
import { loadManifest, runCli } from "./lib.mjs";
import { buildPlan } from "./plan.mjs";

const manifest = loadManifest();
const plan = buildPlan(manifest);

const lightTokens = [
  "灯效",
  "light_control",
  "lightrules",
  "ntf light",
  "ntf.cjs light",
  "light send",
];

console.log(`package:          ${manifest.name} (${manifest.createdFor})`);
console.log(`job:              ${manifest.job.name} (${manifest.job.id})`);
console.log(`message sha256:   ${plan.cron.ok ? plan.cron.messageSha : "unreadable"}`);
console.log(`trigger sha256:   ${plan.cron.ok ? plan.cron.currentTriggerSha : "unreadable"}`);
console.log(
  `toolsAllow:       ${plan.cron.ok ? (plan.cron.currentTools ?? []).join(", ") : "unreadable"}`,
);
for (const entry of plan.config.alsoAllow ?? []) {
  console.log(`alsoAllow ${entry.path}: ${entry.current.join(", ")}`);
}
if (plan.config.deny) {
  console.log(
    `deny ${plan.config.deny.path}: ${plan.config.deny.current.length > 0 ? plan.config.deny.current.join(", ") : "(unset)"}`,
  );
}

let residualMentions = 0;
for (const file of plan.files) {
  if (!file.exists) {
    console.log(`file ${file.spec.path}: MISSING`);
    continue;
  }
  const state = file.changed ? "needs cleanup" : "clean";
  console.log(`file ${file.spec.path}: ${state} (${file.sha.slice(0, 12)})`);
  const currentHits = lightTokens.filter((token) => file.current.includes(token));
  if (currentHits.length > 0) {
    residualMentions += currentHits.length;
    console.log(`  light tokens still present: ${currentHits.join(", ")}`);
  }
}

const plugin = runCli(["plugins", "list", "--json"]);
if (plugin.ok) {
  try {
    const parsed = JSON.parse(plugin.stdout);
    const entry = (parsed.plugins ?? []).find((item) => item.id === "phone-notifications");
    if (entry) {
      const lightTools = (entry.toolNames ?? []).filter(
        (name) => name === "light_control" || name.startsWith("lightrules_"),
      );
      console.log(
        `plugin:           phone-notifications ${entry.version ?? ""} enabled=${entry.enabled} status=${entry.status}`,
      );
      console.log(
        `plugin light tools still registered by vendor: ${lightTools.join(", ") || "(none)"}`,
      );
      console.log(
        "plugin other tools kept: notifications_summary, ai_todo_*, plugin-update, result_deliver",
      );
    } else {
      console.log("plugin:           phone-notifications not found");
    }
  } catch {
    console.log("plugin:           plugins list returned non-JSON");
  }
} else {
  console.log("plugin:           plugins list unavailable");
}

if (plan.errors.length > 0) {
  console.log(`errors:           ${plan.errors.join("; ")}`);
}
if (plan.complete) {
  console.log("state:            deployed");
} else if (residualMentions === 0 && plan.config.deny?.current?.includes("light_control")) {
  console.log("state:            policy applied but files/config still differ");
} else {
  console.log("state:            not deployed");
}
