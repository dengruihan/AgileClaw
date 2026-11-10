const tauri = window["__TAURI__"];
const { invoke } = tauri.core;
const { listen } = tauri.event;

const elements = {
  channel: document.querySelector("#executor-channel"),
  consent: document.querySelector("#executor-consent"),
  detail: document.querySelector("#executor-detail"),
  dot: document.querySelector("#executor-dot"),
  feedback: document.querySelector("#executor-feedback"),
  form: document.querySelector("#executor-form"),
  install: document.querySelector("#executor-install"),
  installProgress: document.querySelector("#executor-install-progress"),
  installSection: document.querySelector("#executor-install"),
  name: document.querySelector("#executor-name"),
  pair: document.querySelector("#executor-pair"),
  restart: document.querySelector("#executor-restart"),
  start: document.querySelector("#executor-start"),
  state: document.querySelector("#executor-state"),
  stop: document.querySelector("#executor-stop"),
  target: document.querySelector("#executor-target"),
};

// App preferences persist across run-state changes; every other field is
// replaced wholesale by each status payload so clears are never retained.
const preferences = { consent: undefined, displayName: undefined };
let status = null;
let pending = false;

function show(element, visible) {
  element.classList.toggle("hidden", !visible);
}

function feedback(message, isError) {
  elements.feedback.textContent = message;
  elements.feedback.classList.toggle("error", Boolean(isError));
  show(elements.feedback, Boolean(message));
}

const PHASES = {
  off: { label: "Off", dot: "idle" },
  preparing: { label: "Connecting…", dot: "working" },
  "waiting-for-approval": {
    label: "Waiting for approval on the controlling Gateway",
    dot: "working",
  },
  running: { label: "Running", dot: "idle" },
  error: { label: "Needs attention", dot: "error" },
};

function statusLabel() {
  const phase = PHASES[status.phase] ?? PHASES.off;
  // Progress phases describe the action, not the service state.
  if (status.phase === "waiting-for-approval") {
    return phase.label;
  }
  if (status.phase === "preparing") {
    return status.mode === "service" ? "Installing service…" : phase.label;
  }
  if (status.mode === "service") {
    return status.phase === "running"
      ? "Running (background service)"
      : "Stopped (background service)";
  }
  if (status.phase === "off" && status.serviceInstalled === null && status.paired !== true) {
    return "Service status unknown";
  }
  return phase.label;
}

function render() {
  if (!status) {
    return;
  }
  const phase = PHASES[status.phase] ?? PHASES.off;
  elements.state.textContent = `Status: ${statusLabel()}`;
  elements.detail.textContent = status.detail ?? "";
  elements.dot.className = `status-dot ${phase.dot}`;
  elements.consent.checked = preferences.consent === true;
  if (preferences.displayName && !elements.name.value) {
    elements.name.value = preferences.displayName;
  }
  show(elements.installSection, status.cliAvailable === false);
  elements.target.disabled = status.cliAvailable === false;
  elements.name.disabled = status.cliAvailable === false;

  const busy = status.phase === "preparing";
  const controlled = status.phase === "running" || status.phase === "waiting-for-approval";
  const installed = status.serviceInstalled === true || status.mode === "service";
  // Start requires consent plus either confirmed canonical pairing (a
  // reconnect) or an owned service (service start); a fresh Start without
  // either must never create pairing state on its own.
  const serviceOwned = status.mode === "service" || status.serviceInstalled === true;
  elements.start.disabled =
    pending ||
    busy ||
    status.consent !== true ||
    (!serviceOwned && status.paired !== true) ||
    !(status.phase === "off" || status.phase === "error");
  // Stop can always cancel an app-owned child or stop a controlled device.
  elements.stop.disabled = pending || !(controlled || installed || busy);
  elements.restart.disabled =
    pending ||
    busy ||
    status.consent !== true ||
    !(controlled || installed || serviceOwned);
  elements.pair.disabled = pending || preferences.consent !== true;
}

function applyPayload(payload) {
  status = {
    ...payload,
    consent: preferences.consent,
    displayName: preferences.displayName,
  };
}

async function send(message) {
  if (pending) {
    return;
  }
  pending = true;
  render();
  try {
    const snapshot = await invoke("executor_node_request", { message });
    if (snapshot.consent !== undefined) {
      preferences.consent = snapshot.consent;
    }
    if (snapshot.displayName !== undefined) {
      preferences.displayName = snapshot.displayName;
    }
    applyPayload(snapshot);
    feedback("", false);
  } catch (error) {
    feedback(
      typeof error === "string" ? error : error?.message || "The action did not finish.",
      true,
    );
  } finally {
    pending = false;
    render();
  }
}

elements.consent.addEventListener("change", () => {
  preferences.consent = elements.consent.checked;
  void send({ type: "set-consent", value: elements.consent.checked });
});

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (preferences.consent !== true) {
    feedback("Approve remote control first.", true);
    return;
  }
  const target = elements.target.value.trim();
  if (!target) {
    elements.target.setAttribute("aria-invalid", "true");
    elements.target.focus();
    feedback("Paste the join URL or setup code to continue.", true);
    return;
  }
  elements.target.removeAttribute("aria-invalid");
  const mode = document.querySelector('input[name="executor-mode"]:checked')?.value;
  // Replacing a running service is serialized by the controller: it stops and
  // reconciles the old service before any replacement runs.
  void send({
    type: "pair",
    target,
    displayName: elements.name.value.trim() || null,
    mode,
    consent: true,
  }).then(() => {
    if (!elements.feedback.classList.contains("error")) {
      elements.target.value = "";
    }
  });
});

for (const [id, type] of [
  ["executor-start", "start"],
  ["executor-stop", "stop"],
  ["executor-restart", "restart"],
]) {
  document.querySelector(`#${id}`).addEventListener("click", () => {
    void send({ type });
  });
}

elements.install.addEventListener("click", () => {
  if (pending) {
    return;
  }
  elements.install.disabled = true;
  elements.channel.disabled = true;
  elements.installProgress.textContent = "Installing…";
  invoke("executor_node_request", {
    message: { type: "install-cli", channel: elements.channel.value },
  })
    .then((snapshot) => {
      preferences.consent = snapshot.consent;
      preferences.displayName = snapshot.displayName;
      applyPayload(snapshot);
      elements.installProgress.textContent = "Install complete.";
    })
    .catch((error) => {
      elements.installProgress.textContent =
        typeof error === "string" ? error : error?.message || "The install did not finish.";
    })
    .finally(() => {
      elements.install.disabled = false;
      elements.channel.disabled = false;
      render();
    });
});

await listen("install-progress", ({ payload }) => {
  let line = payload.line ?? "";
  try {
    const event = JSON.parse(line);
    if (event?.event === "done" && event.ok === true) {
      line = `✓ Installed${event.version ? ` ${event.version}` : ""}`;
    } else if (event?.event === "step" && event.name) {
      const mark = { start: "→", ok: "✓", skip: "–", warn: "!" }[event.status] ?? "";
      line = `${mark} ${event.name}`;
    }
  } catch {
    // Plain installer output renders as-is.
  }
  elements.installProgress.textContent = line;
});

await listen("executor://status-changed", ({ payload }) => {
  applyPayload(payload);
  render();
});

const snapshot = await invoke("executor_node_request", { message: { type: "status" } });
preferences.consent = snapshot.consent;
preferences.displayName = snapshot.displayName;
applyPayload(snapshot);
render();
