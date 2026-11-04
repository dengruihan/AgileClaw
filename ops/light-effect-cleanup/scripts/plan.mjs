// Read-only planning: compares the live surfaces with the cleanup manifest.
//
// deploy/status/rollback all use this module, so the reviewed plan and the
// applied plan cannot drift apart.
import {
  applyOps,
  configGet,
  cronGet,
  fileMode,
  fmtList,
  readText,
  sha256,
  targetPath,
} from "./lib.mjs";

function setPath(target, dotted, value) {
  const parts = dotted.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    cursor[part] ??= {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

function analyzeFiles(manifest) {
  return manifest.files.map((spec, index) => {
    const path = targetPath(spec.path);
    let current = null;
    let readError = null;
    try {
      current = readText(path);
    } catch (error) {
      readError = error.message;
    }
    if (current === null) {
      return { spec, index, path, readError, exists: false, changed: null, errors: [readError] };
    }
    const sha = sha256(current);
    const baselineMatch = sha === spec.baselineSha256;
    const result = applyOps(current, spec.ops);
    return {
      spec,
      index,
      path,
      exists: true,
      current,
      sha,
      baselineMatch,
      next: result.text,
      nextSha: sha256(result.text),
      changed: result.changed,
      applied: result.applied,
      errors: result.errors,
      mode: fileMode(path),
    };
  });
}

function analyzeCron(manifest, jobId) {
  const spec = manifest.job;
  const result = cronGet(jobId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const job = result.value;
  if (job.id !== spec.id) {
    return { ok: false, error: `unexpected job id ${job.id} (expected ${spec.id})` };
  }
  if (job.name !== spec.name) {
    return { ok: false, error: `unexpected job name ${job.name} (expected ${spec.name})` };
  }
  const message = job.payload?.message ?? "";
  const messageHits = (spec.forbiddenInMessage ?? []).filter((token) => message.includes(token));
  const currentTools = Array.isArray(job.payload?.toolsAllow) ? job.payload.toolsAllow : null;
  if (!currentTools) {
    return { ok: false, error: "job payload.toolsAllow is not an array" };
  }
  const removeSet = new Set(spec.removeTools);
  const desiredTools = currentTools.filter((tool) => !removeSet.has(tool));
  const trigger = job.trigger?.script ?? "";
  if (!trigger) {
    return { ok: false, error: "job trigger.script is missing" };
  }
  const triggerResult = applyOps(
    trigger,
    (spec.triggerReplacements ?? []).map((replacement) => ({
      type: "replace",
      ...replacement,
    })),
  );
  return {
    ok: true,
    job,
    message,
    messageSha: sha256(message),
    messageHits,
    currentTools,
    desiredTools,
    toolsChanged: JSON.stringify(currentTools) !== JSON.stringify(desiredTools),
    currentTrigger: trigger,
    currentTriggerSha: sha256(trigger),
    desiredTrigger: triggerResult.text,
    desiredTriggerSha: sha256(triggerResult.text),
    triggerChanged: triggerResult.changed,
    triggerApplied: triggerResult.applied,
    triggerErrors: triggerResult.errors,
  };
}

function analyzeConfig(manifest) {
  const spec = manifest.config;
  const removeSet = new Set(spec.removeFromAlsoAllow);
  const alsoAllow = [];
  const errors = [];

  for (const path of spec.alsoAllowPaths) {
    const result = configGet(path);
    if (!result.ok) {
      errors.push(`${path}: ${result.error}`);
      continue;
    }
    if (result.unset) {
      errors.push(`${path}: expected an authored array, but it is unset`);
      continue;
    }
    if (!Array.isArray(result.value)) {
      errors.push(`${path}: expected an array`);
      continue;
    }
    const next = result.value.filter((entry) => !removeSet.has(entry));
    alsoAllow.push({
      path,
      current: result.value,
      next,
      changed: JSON.stringify(result.value) !== JSON.stringify(next),
      removed: result.value.filter((entry) => removeSet.has(entry)),
    });
  }

  const denyResult = configGet(spec.denyPath);
  if (!denyResult.ok) {
    errors.push(`${spec.denyPath}: ${denyResult.error}`);
  }
  const currentDeny = denyResult.ok && !denyResult.unset ? denyResult.value : [];
  if (!Array.isArray(currentDeny)) {
    errors.push(`${spec.denyPath}: expected an array when set`);
  }
  const nextDeny = [...currentDeny];
  for (const tool of spec.denyTools) {
    if (!nextDeny.includes(tool)) {
      nextDeny.push(tool);
    }
  }

  const patch = {};
  for (const entry of alsoAllow) {
    if (entry.changed) {
      setPath(patch, entry.path, entry.next);
    }
  }
  const denyChanged = JSON.stringify(currentDeny) !== JSON.stringify(nextDeny);
  if (denyChanged) {
    setPath(patch, spec.denyPath, nextDeny);
  }

  return {
    ok: errors.length === 0,
    errors,
    alsoAllow,
    deny: {
      path: spec.denyPath,
      wasUnset: Boolean(denyResult.ok && denyResult.unset),
      current: currentDeny,
      next: nextDeny,
      changed: denyChanged,
    },
    patch,
    patchChanged: Object.keys(patch).length > 0,
  };
}

export function buildPlan(manifest, jobId = manifest.job.id) {
  const files = analyzeFiles(manifest);
  const cron = analyzeCron(manifest, jobId);
  const config = analyzeConfig(manifest);
  const errors = [];
  for (const file of files) {
    if (file.readError) {
      errors.push(`${file.path}: ${file.readError}`);
    } else if (file.errors.length > 0) {
      errors.push(`${file.path}: ${file.errors.join("; ")}`);
    } else {
      for (const token of manifest.forbiddenAfter ?? []) {
        if (file.next.includes(token)) {
          errors.push(`${file.path}: patch would leave forbidden token "${token}"`);
        }
      }
    }
  }
  if (!cron.ok) {
    errors.push(`cron: ${cron.error}`);
  } else {
    if (cron.messageHits.length > 0) {
      errors.push(`cron payload.message still mentions ${fmtList(cron.messageHits)}`);
    }
    if (cron.triggerErrors.length > 0) {
      errors.push(`cron trigger: ${cron.triggerErrors.join("; ")}`);
    }
    for (const token of manifest.forbiddenAfter ?? []) {
      if (cron.desiredTrigger.includes(token)) {
        errors.push(`cron trigger: patch would leave forbidden token "${token}"`);
      }
    }
  }
  if (!config.ok) {
    errors.push(...config.errors.map((error) => `config: ${error}`));
  } else {
    for (const entry of config.alsoAllow) {
      for (const tool of manifest.config.removeFromAlsoAllow) {
        if (entry.next.includes(tool)) {
          errors.push(`config ${entry.path}: ${tool} would remain in alsoAllow`);
        }
      }
    }
  }
  return {
    files,
    cron,
    config,
    errors,
    complete:
      errors.length === 0 &&
      files.every((file) => !file.changed) &&
      !cron.toolsChanged &&
      !cron.triggerChanged &&
      !config.patchChanged,
  };
}
