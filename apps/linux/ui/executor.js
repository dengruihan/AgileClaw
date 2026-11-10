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
  install: document.querySelector("#executor-install-button"),
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
  // Errors and progress phases describe the action; they are never collapsed
  // into a service state.
  if (status.phase === "error") {
    return phase.label;
  }
  if (status.phase === "waiting-for-approval") {
    return phase.label;
  }
  if (status.phase === "preparing") {
    return status.mode === "service" ? "Installing service…" : phase.label;
  }
  if (status.mode === "service") {
    if (status.phase === "running" || status.serviceRunning === true) {
      return "Running (background service)";
    }
    if (status.serviceRunning === false) {
      return "Stopped (background service)";
    }
    return "Service status unknown";
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
  // A command's returned snapshot can be read before the supervisor publishes
  // the request's preparing state. Never let that older read replace a newer
  // status event (for example, back to Running during re-pair preparation).
  if (status && payload.revision < status.revision) {
    return;
  }
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

let installPending = false;

elements.install.addEventListener("click", () => {
  if (installPending) {
    return;
  }
  installPending = true;
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
    .catch(() => {
      // Installer failures carry raw tool output (including command-shaped
      // remediation); the window only ever shows app-authored guidance.
      elements.installProgress.textContent =
        "The CLI install did not finish. Try again, or check the install log in the OpenClaw window.";
    })
    .finally(() => {
      installPending = false;
      elements.install.disabled = false;
      elements.channel.disabled = false;
      render();
    });
});

await listen("install-progress", ({ payload }) => {
  // Structured step events only; raw installer output is never rendered here.
  let line;
  try {
    const event = JSON.parse(payload.line ?? "");
    if (!event || event.event !== "step" || !event.name) {
      return;
    }
    const mark = { start: "→", ok: "✓", skip: "–", warn: "!" }[event.status] ?? "";
    line = `${mark} ${event.name}`;
  } catch {
    return;
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
