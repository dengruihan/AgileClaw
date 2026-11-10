const tauri = window["__TAURI__"];
const { invoke } = tauri.core;
const { listen } = tauri.event;

const elements = {
  consent: document.querySelector("#executor-consent"),
  detail: document.querySelector("#executor-detail"),
  dot: document.querySelector("#executor-dot"),
  feedback: document.querySelector("#executor-feedback"),
  form: document.querySelector("#executor-form"),
  name: document.querySelector("#executor-name"),
  pair: document.querySelector("#executor-pair"),
  restart: document.querySelector("#executor-restart"),
  start: document.querySelector("#executor-start"),
  state: document.querySelector("#executor-state"),
  stop: document.querySelector("#executor-stop"),
  target: document.querySelector("#executor-target"),
  title: document.querySelector("#executor-title"),
};

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
  if (status.mode === "service") {
    return status.phase === "running"
      ? "Running (background service)"
      : "Stopped (background service)";
  }
  if (status.phase === "off" && status.serviceInstalled) {
    return "Service installed";
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
  elements.consent.checked = status.consent === true;
  if (status.displayName && !elements.name.value) {
    elements.name.value = status.displayName;
  }
  const installed = status.serviceInstalled === true;
  const busy = status.phase === "preparing";
  const controlled = status.phase === "running" || status.phase === "waiting-for-approval";
  elements.start.disabled = pending || busy || !(status.phase === "off" || status.phase === "error");
  elements.stop.disabled =
    pending || busy || !(controlled || installed);
  elements.restart.disabled =
    pending || busy || !(controlled || installed);
  elements.pair.disabled = pending || status.consent !== true;
}

async function send(message) {
  if (pending) {
    return;
  }
  pending = true;
  render();
  try {
    status = await invoke("executor_node_request", { message });
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
  void send({ type: "set-consent", value: elements.consent.checked });
});

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!elements.consent.checked) {
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
  const running = status && ["running", "waiting-for-approval", "preparing"].includes(status.phase);
  void (async () => {
    if (running) {
      await send({ type: "stop" });
    }
    await send({
      type: "pair",
      target,
      displayName: elements.name.value.trim() || null,
      mode,
      consent: elements.consent.checked,
    });
    if (!elements.feedback.classList.contains("error")) {
      elements.target.value = "";
    }
  })();
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

await listen("executor://status-changed", ({ payload }) => {
  // Event payloads omit app preferences; keep the values this window loaded.
  status = { ...(status ?? {}), ...payload };
  render();
});

status = await invoke("executor_node_request", { message: { type: "status" } });
render();
