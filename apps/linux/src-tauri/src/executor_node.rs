//! The companion supervises one controlled executor node; the CLI owns pairing
//! state, occupancy leases, and services. Pairing secrets live only in a
//! 0600 handoff file that the CLI consumes and deletes.
use crate::cli::OpenClawCli;
use crate::desktop_node_process::DesktopNodeProcess;
use crate::gateway_profiles::GatewayProfiles;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) const EXECUTOR_LABEL: &str = "executor";
const STATUS_EVENT: &str = "executor://status-changed";
const SETUP_CODE_PREFIX: &str = "oc-pair://";
const JOIN_CODE_LENGTH: usize = 22;
const CONNECTED_MARKER: &str = "node host gateway connected:";
const PAUSED_MARKER: &str = "node host gateway reconnect paused";
const PAIRING_REQUIRED_MARKER: &str = "PAIRING_REQUIRED";
/// The explicit minimal remote-execution surface. An explicit list REPLACES the
/// executor profile defaults, so it must stay a working executor on its own:
/// `system.run` with its approval policy plus the whole occupancy lease
/// lifecycle that admits every other command.
const EXECUTOR_COMMANDS: [&str; 10] = [
    "system.run.prepare",
    "system.run",
    "system.which",
    "system.execApprovals.get",
    "system.execApprovals.set",
    "occupancy.acquire.v1",
    "occupancy.renew.v1",
    "occupancy.release.v1",
    "occupancy.status.v1",
    "occupancy.revoke.v1",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Off,
    Preparing,
    WaitingApproval,
    Running,
    Error,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Preparing => "preparing",
            Self::WaitingApproval => "waiting-for-approval",
            Self::Running => "running",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Debug)]
struct Run {
    phase: Phase,
    mode: Option<&'static str>,
    service_installed: Option<bool>,
    detail: Option<String>,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub revision: u64,
    pub phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_installed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

impl Snapshot {
    fn from_run(revision: u64, run: &Run) -> Self {
        Self {
            revision,
            phase: run.phase.as_str(),
            mode: run.mode,
            service_installed: run.service_installed,
            detail: run.detail.clone(),
            consent: None,
            display_name: None,
        }
    }
}

#[derive(Clone, Debug)]
enum Request {
    Idle,
    Foreground { pairing: Option<Pairing> },
    ServiceInstall(Pairing),
    Service(ToolAction),
    Probe,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ToolAction {
    Start,
    Stop,
    Restart,
}

#[derive(Clone, Debug)]
struct Pairing {
    handoff: Arc<TargetHandoff>,
    display_name: Option<String>,
    redactions: Vec<String>,
}

#[derive(Debug)]
struct Shared {
    revision: u64,
    request: Request,
    stopping: bool,
    status_revision: u64,
    status: Run,
}

/// One unredeemed join URL or setup code, held at 0600 until the CLI consumes it.
#[derive(Debug)]
struct TargetHandoff {
    path: PathBuf,
}

impl TargetHandoff {
    fn write(root: &Path, target: &str) -> Result<Self, String> {
        std::fs::create_dir_all(root)
            .map_err(|error| format!("Could not prepare the controlled-device state: {error}"))?;
        let path = root.join(format!("handoff-{}", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&path)
            .map_err(|error| format!("Could not stage the pairing secret: {error}"))?;
        file.write_all(target.as_bytes())
            .and_then(|()| file.flush())
            .map_err(|error| {
                let _ = std::fs::remove_file(&path);
                format!("Could not stage the pairing secret: {error}")
            })?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn remove(&self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Drop for TargetHandoff {
    fn drop(&mut self) {
        self.remove();
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

/// Classify a pasted pairing secret without ever echoing it back.
fn parse_target(raw: &str) -> Result<(String, Vec<String>), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Paste the join URL or setup code from the controlling Gateway.".into());
    }
    if let Some(code) = trimmed.strip_prefix(SETUP_CODE_PREFIX) {
        let bootstrap_token = validate_setup_code(code)?;
        // Cover both handoff encodings plus the decoded bearer the CLI may log.
        return Ok((
            trimmed.to_string(),
            vec![trimmed.to_string(), code.to_string(), bootstrap_token],
        ));
    }
    validate_join_url(trimmed)?;
    Ok((trimmed.to_string(), vec![trimmed.to_string()]))
}

fn validate_setup_code(code: &str) -> Result<String, String> {
    if code.is_empty()
        || !code
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err("That setup code is not valid. Copy the whole code and paste it again.".into());
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(code.as_bytes())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let Some(payload) = decoded else {
        return Err("That setup code is not valid. Copy the whole code and paste it again.".into());
    };
    let gateway_url = payload.get("url").and_then(Value::as_str);
    let bootstrap_token = payload.get("bootstrapToken").and_then(Value::as_str);
    let valid_url = gateway_url
        .map(|url| url.starts_with("ws://") || url.starts_with("wss://"))
        .unwrap_or(false);
    if !valid_url || bootstrap_token.is_none_or(str::is_empty) {
        return Err("That setup code is not valid. Copy the whole code and paste it again.".into());
    }
    if let Some(expires_at) = payload.get("expiresAtMs").and_then(Value::as_u64) {
        if u128::from(expires_at) <= now_ms() {
            return Err(
                "That setup code has expired. Ask the controlling Gateway for a fresh one.".into(),
            );
        }
    }
    Ok(bootstrap_token
        .expect("validated bootstrap token")
        .to_string())
}

fn validate_join_url(raw: &str) -> Result<(), String> {
    let url = tauri::Url::parse(raw)
        .map_err(|_| "Paste the whole join URL, ending in /j/<code>.".to_string())?;
    let loopback = matches!(url.host_str(), Some("localhost") | Some("[::1]"))
        || url
            .host_str()
            .and_then(|host| {
                host.trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<std::net::IpAddr>()
                    .ok()
            })
            .is_some_and(|ip| ip.is_loopback());
    if url.scheme() == "http" && !loopback {
        return Err("Join URLs must use HTTPS unless the Gateway runs on this computer.".into());
    }
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("Paste the whole join URL, ending in /j/<code>.".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("That join URL carries extra parts. Copy the URL exactly as shown.".into());
    }
    let Some(path) = url.path().rsplit_once("/j/") else {
        return Err("Paste the whole join URL, ending in /j/<code>.".into());
    };
    let code = path.1;
    let valid = code.len() == JOIN_CODE_LENGTH
        && !code
            .chars()
            .any(|ch| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'));
    if !valid {
        return Err("That join URL is not valid. Copy the whole URL and paste it again.".into());
    }
    Ok(())
}

fn pairing_arguments(
    handoff: &TargetHandoff,
    display_name: Option<&str>,
    service: bool,
) -> Vec<String> {
    let mut args = vec![
        "connect".into(),
        "--target-file".into(),
        handoff.path().to_string_lossy().into_owned(),
        "--executor".into(),
        "--commands".into(),
        EXECUTOR_COMMANDS.join(","),
    ];
    if service {
        args.push("--service".into());
    }
    if let Some(name) = display_name {
        args.extend(["--display-name".into(), name.to_string()]);
    }
    args
}

fn reconnect_arguments() -> Vec<String> {
    vec!["node".into(), "run".into(), "--executor".into()]
}

fn service_arguments(action: ToolAction) -> Vec<String> {
    let verb = match action {
        ToolAction::Start => "start",
        ToolAction::Stop => "stop",
        ToolAction::Restart => "restart",
    };
    vec!["node".into(), verb.into()]
}

fn status_arguments() -> Vec<String> {
    vec!["node".into(), "status".into(), "--json".into()]
}

/// Map a node-host diagnostic to an app phase. Lines stay app-authored; raw
/// CLI output is only ever a sanitized, command-free tail.
fn classify_progress(line: &str) -> Option<Phase> {
    if line.contains(CONNECTED_MARKER) {
        return Some(Phase::Running);
    }
    if line.contains(PAUSED_MARKER) {
        return if line.contains(PAIRING_REQUIRED_MARKER) {
            Some(Phase::WaitingApproval)
        } else {
            Some(Phase::Preparing)
        };
    }
    None
}

fn sanitize_diagnostic(line: &str, secrets: &[String]) -> Option<String> {
    // The GUI never presents terminal commands, including ones the CLI echoes.
    if line.contains("openclaw ") || line.trim().is_empty() {
        return None;
    }
    let mut message = line.to_string();
    for secret in secrets {
        message = message.replace(secret, "[redacted]");
    }
    Some(
        message
            .chars()
            .filter(|ch| !ch.is_control())
            .take(300)
            .collect(),
    )
}

fn remediation(stdout: &str, stderr: &str) -> Option<&'static str> {
    let combined = format!("{stdout}\n{stderr}");
    if combined.contains("Connect target is required") {
        return Some("This computer is not paired yet. Paste a new join URL or setup code below.");
    }
    if combined.contains("not found or has expired") {
        return Some("That join link expired or was already used. Ask for a fresh one.");
    }
    if combined.contains("has expired") {
        return Some("That setup code has expired. Ask the controlling Gateway for a fresh one.");
    }
    if combined.contains("Invalid pairing setup code") {
        return Some("That setup code could not be read. Copy the whole code and paste it again.");
    }
    if combined.contains("Join URL must end with") {
        return Some("That join URL is not valid. Copy the whole URL and paste it again.");
    }
    None
}

pub(crate) struct ExecutorNode {
    shared: Arc<Mutex<Shared>>,
    profiles: Arc<GatewayProfiles>,
    sender: mpsc::SyncSender<()>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl ExecutorNode {
    pub fn start(app: AppHandle, profiles: Arc<GatewayProfiles>) -> Result<Self, String> {
        let shared = Arc::new(Mutex::new(Shared {
            revision: 0,
            request: Request::Idle,
            stopping: false,
            status_revision: 0,
            status: Run {
                phase: Phase::Off,
                mode: None,
                service_installed: None,
                detail: None,
            },
        }));
        let (sender, receiver) = mpsc::sync_channel(1);
        let state = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("executor-node".into())
            .spawn(move || {
                run(app, state, receiver);
            })
            .map_err(|error| {
                format!("Could not start the controlled-device supervisor: {error}")
            })?;
        Ok(Self {
            shared,
            profiles,
            sender,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn snapshot(&self) -> Snapshot {
        let (revision, run) = {
            let shared = self.shared.lock().expect("executor state");
            (shared.status_revision, shared.status.clone())
        };
        let mut snapshot = Snapshot::from_run(revision, &run);
        snapshot.consent = self.profiles.executor_consent().ok().flatten();
        snapshot.display_name = self.profiles.executor_display_name().ok().flatten();
        snapshot
    }

    /// Probe the installed service so a fresh window or tray reflects durable
    /// state; never submitted while another request owns the supervisor.
    pub fn refresh(&self) -> Result<(), String> {
        {
            let shared = self
                .shared
                .lock()
                .map_err(|_| "Controlled device unavailable.")?;
            if shared.stopping {
                return Err("OpenClaw is quitting.".into());
            }
            if !matches!(shared.request, Request::Idle) {
                return Ok(());
            }
        }
        self.submit(Request::Probe)
    }

    /// Tray and window controls share this dispatch: an app-owned foreground
    /// child stops first, then an installed service absorbs the action.
    pub fn action(&self, action: ToolAction) -> Result<(), String> {
        let request = {
            let shared = self
                .shared
                .lock()
                .map_err(|_| "Controlled device unavailable.")?;
            let run = &shared.status;
            if action == ToolAction::Stop && run.mode == Some("foreground") {
                Request::Idle
            } else if run.service_installed == Some(true) {
                Request::Service(action)
            } else {
                match action {
                    ToolAction::Start | ToolAction::Restart => {
                        Request::Foreground { pairing: None }
                    }
                    ToolAction::Stop => Request::Idle,
                }
            }
        };
        self.submit(request)
    }

    pub fn set_consent(&self, consent: bool) -> Result<(), String> {
        self.profiles.set_executor_consent(consent)
    }

    /// Stage the pairing secret at 0600 and hand the path to the CLI. The
    /// secret itself never reaches argv, env, logs, or service definitions.
    pub fn pair(
        &self,
        target: &str,
        display_name: Option<&str>,
        service: bool,
        root: &Path,
    ) -> Result<(), String> {
        let (secret, redactions) = parse_target(target)?;
        let handoff = TargetHandoff::write(root, &secret)?;
        let pairing = Pairing {
            handoff: Arc::new(handoff),
            display_name: display_name
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string),
            redactions,
        };
        if let Some(name) = pairing.display_name.as_deref() {
            self.profiles.set_executor_display_name(Some(name))?;
        }
        let request = if service {
            Request::ServiceInstall(pairing)
        } else {
            Request::Foreground {
                pairing: Some(pairing),
            }
        };
        self.submit(request)
    }

    fn submit(&self, request: Request) -> Result<(), String> {
        {
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| "Controlled device unavailable.")?;
            if shared.stopping {
                return Err("OpenClaw is quitting.".into());
            }
            shared.revision += 1;
            shared.request = request;
        }
        match self.sender.try_send(()) {
            Ok(()) | Err(mpsc::TrySendError::Full(())) => Ok(()),
            Err(mpsc::TrySendError::Disconnected(())) => Err(
                "The controlled-device supervisor stopped unexpectedly. Restart OpenClaw-Tauri."
                    .into(),
            ),
        }
    }

    pub fn stop(&self) {
        let mut shared = self.shared.lock().expect("executor state");
        shared.stopping = true;
        shared.revision += 1;
        shared.request = Request::Idle;
        drop(shared);
        let _ = self.sender.try_send(());
    }

    pub fn wait_stopped(&self) {
        self.stop();
        if let Some(worker) = self.worker.lock().expect("executor worker").take() {
            if worker.join().is_err() {
                eprintln!("Controlled device shutdown failed.");
            }
        }
    }
}

fn publish(app: &AppHandle, shared: &Mutex<Shared>, revision: u64, run: Run) {
    {
        let mut current = shared.lock().expect("executor state");
        if current.stopping || current.revision != revision {
            return;
        }
        current.status = run;
        current.status_revision += 1;
    }
    notify(app, shared);
}

fn notify(app: &AppHandle, shared: &Mutex<Shared>) {
    let snapshot = {
        let current = shared.lock().expect("executor state");
        Snapshot::from_run(current.status_revision, &current.status)
    };
    crate::tray::publish_executor(app, &snapshot);
    let _ = app.emit_to(EXECUTOR_LABEL, STATUS_EVENT, snapshot);
}

/// Tray actions mirror the window's controls; a missing CLI becomes a visible
/// notification instead of a silent no-op.
pub(crate) fn submit_tray_action(app: &AppHandle, action: ToolAction) {
    let node = app.state::<ExecutorNode>();
    if let Err(error) = node.action(action) {
        eprintln!("Controlled device action failed: {error}");
        crate::notify::notify(app, "Controlled device", &error);
    }
}

fn drain_output(
    process: &mut DesktopNodeProcess,
    secrets: &[String],
    tail: &mut VecDeque<String>,
) -> Option<Phase> {
    let mut phase = None;
    for (_, line) in process.output() {
        if let Some(sanitized) = sanitize_diagnostic(&line, secrets) {
            tail.push_back(sanitized);
            if tail.len() > 4 {
                tail.pop_front();
            }
        }
        if let Some(next) = classify_progress(&line) {
            phase = Some(next);
        }
    }
    phase
}

fn run_to_completion(
    cli: &OpenClawCli,
    args: &[String],
    cancelled: impl Fn() -> bool,
    probe_owner: &mut Option<DesktopNodeProcess>,
) -> Result<Output, String> {
    let command = cli
        .command(args.to_vec())
        .map_err(|error| error.to_string())?;
    DesktopNodeProcess::probe(command, cancelled, probe_owner)?
        .ok_or_else(|| "The controlled-device setup was superseded.".to_string())
}

fn probe_service_status(
    cli: &OpenClawCli,
    cancelled: impl Fn() -> bool,
    probe_owner: &mut Option<DesktopNodeProcess>,
) -> Result<Option<bool>, String> {
    let output = run_to_completion(cli, &status_arguments(), cancelled, probe_owner)?;
    if !output.status.success() {
        return Ok(None);
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "The CLI returned an invalid controlled-device service status.".to_string())?;
    Ok(value
        .get("service")
        .and_then(|service| service.get("loaded"))
        .and_then(Value::as_bool))
}

fn tail_text(tail: &VecDeque<String>) -> String {
    tail.iter().cloned().collect::<Vec<_>>().join("\n")
}

fn run(app: AppHandle, shared: Arc<Mutex<Shared>>, receiver: mpsc::Receiver<()>) {
    let mut child: Option<DesktopNodeProcess> = None;
    let mut probe_owner: Option<DesktopNodeProcess> = None;
    let mut applied: Option<u64> = None;
    let mut redactions: Vec<String> = Vec::new();
    let mut tail: VecDeque<String> = VecDeque::new();
    loop {
        let (revision, request, stopping) = {
            let shared = shared.lock().expect("executor state");
            (shared.revision, shared.request.clone(), shared.stopping)
        };
        if applied != Some(revision) {
            // Join every owned process before any replacement or shutdown.
            let mut cleanup_failed = false;
            for owner in [&mut child, &mut probe_owner] {
                if let Some(process) = owner.as_mut() {
                    if let Err(error) = process.stop() {
                        publish(
                            &app,
                            &shared,
                            revision,
                            Run {
                                phase: Phase::Error,
                                mode: None,
                                service_installed: None,
                                detail: Some(error),
                            },
                        );
                        cleanup_failed = true;
                        continue;
                    }
                }
                owner.take();
            }
            if cleanup_failed {
                // Keep every unresolved owner; a replacement never outruns teardown.
                let _ = receiver.recv_timeout(Duration::from_secs(1));
                continue;
            }
            if stopping {
                break;
            }
            applied = Some(revision);
            tail.clear();
            match request {
                Request::Idle => publish(
                    &app,
                    &shared,
                    revision,
                    Run {
                        phase: Phase::Off,
                        mode: None,
                        service_installed: None,
                        detail: None,
                    },
                ),
                Request::Probe => {
                    redactions.clear();
                    let cli = OpenClawCli::locate();
                    let outcome = cli
                        .map_err(|_| {
                            "Install or update the local OpenClaw CLI to see the controlled device."
                                .to_string()
                        })
                        .and_then(|cli| {
                            let cancelled = || {
                                let shared = shared.lock().expect("executor state");
                                shared.stopping || shared.revision != revision
                            };
                            let mut probe_owner = None;
                            probe_service_status(&cli, cancelled, &mut probe_owner).map(|loaded| {
                                Run {
                                    phase: Phase::Off,
                                    mode: None,
                                    service_installed: loaded,
                                    detail: loaded
                                        .map(|installed| {
                                            if installed {
                                                String::from("The background service is installed.")
                                            } else {
                                                String::new()
                                            }
                                        })
                                        .filter(|detail| !detail.is_empty()),
                                }
                            })
                        });
                    finish_tool_run(&app, &shared, revision, outcome, &mut tail, None);
                }
                Request::Foreground { pairing } => {
                    publish(
                        &app,
                        &shared,
                        revision,
                        Run {
                            phase: Phase::Preparing,
                            mode: Some("foreground"),
                            service_installed: None,
                            detail: Some(String::from("Connecting this computer.")),
                        },
                    );
                    match prepare_foreground(&pairing, &mut redactions) {
                        Err(error) => publish(
                            &app,
                            &shared,
                            revision,
                            Run {
                                phase: Phase::Error,
                                mode: Some("foreground"),
                                service_installed: None,
                                detail: Some(error),
                            },
                        ),
                        Ok(command) => match DesktopNodeProcess::spawn(command) {
                            Ok(process) => {
                                child = Some(process);
                            }
                            Err(error) => publish(
                                &app,
                                &shared,
                                revision,
                                Run {
                                    phase: Phase::Error,
                                    mode: Some("foreground"),
                                    service_installed: None,
                                    detail: Some(error),
                                },
                            ),
                        },
                    }
                }
                Request::ServiceInstall(pairing) => {
                    publish(
                        &app,
                        &shared,
                        revision,
                        Run {
                            phase: Phase::Preparing,
                            mode: Some("service"),
                            service_installed: None,
                            detail: Some(String::from("Pairing and installing the service.")),
                        },
                    );
                    let outcome = apply_service_request(
                        &pairing,
                        true,
                        &mut redactions,
                        &mut probe_owner,
                        &shared,
                        revision,
                    );
                    finish_tool_run(&app, &shared, revision, outcome, &mut tail, Some("service"));
                }
                Request::Service(action) => {
                    publish(
                        &app,
                        &shared,
                        revision,
                        Run {
                            phase: Phase::Preparing,
                            mode: Some("service"),
                            service_installed: None,
                            detail: Some(String::from("Applying the service change.")),
                        },
                    );
                    redactions.clear();
                    let outcome = apply_tool_action(&shared, revision, action, &mut probe_owner);
                    finish_tool_run(&app, &shared, revision, outcome, &mut tail, Some("service"));
                }
            }
        }
        if let Some(process) = child.as_mut() {
            if let Some(phase) = drain_output(process, &redactions, &mut tail) {
                let changed = {
                    let mut current = shared.lock().expect("executor state");
                    if current.revision == revision && current.status.phase != phase {
                        current.status.phase = phase;
                        current.status.detail = Some(match phase {
                            Phase::Running => {
                                String::from("Connected. This computer is under remote control.")
                            }
                            Phase::WaitingApproval => {
                                String::from("Waiting for approval on the controlling Gateway.")
                            }
                            _ => String::from("Connecting this computer."),
                        });
                        current.status_revision += 1;
                        true
                    } else {
                        false
                    }
                };
                if changed {
                    notify(&app, &shared);
                }
            }
            match process.exited() {
                Ok(false) => {}
                outcome => {
                    let _ = process.stop();
                    let error = match outcome {
                        Err(error) => Some(error),
                        Ok(true) => {
                            let text = tail_text(&tail);
                            remediation("", &text).map(String::from).or_else(|| {
                                Some(String::from(
                                    "The controlled device stopped unexpectedly. Start it again or pair below.",
                                ))
                            })
                        }
                        Ok(false) => None,
                    };
                    publish(
                        &app,
                        &shared,
                        revision,
                        Run {
                            phase: if error.is_some() {
                                Phase::Error
                            } else {
                                Phase::Off
                            },
                            mode: Some("foreground"),
                            service_installed: None,
                            detail: error,
                        },
                    );
                    child = None;
                }
            }
        }
        let _ = receiver.recv_timeout(Duration::from_millis(250));
    }
}

fn prepare_foreground(
    pairing: &Option<Pairing>,
    redactions: &mut Vec<String>,
) -> Result<std::process::Command, String> {
    let cli = OpenClawCli::locate().map_err(|_| {
        "Install or update the local OpenClaw CLI first, then try again.".to_string()
    })?;
    let args = match pairing {
        Some(pairing) => {
            *redactions = pairing.redactions.clone();
            pairing_arguments(&pairing.handoff, pairing.display_name.as_deref(), false)
        }
        None => {
            redactions.clear();
            reconnect_arguments()
        }
    };
    let mut command = cli.command(args).map_err(|error| error.to_string())?;
    command
        .env_remove("CF_ACCESS_CLIENT_ID")
        .env_remove("CF_ACCESS_CLIENT_SECRET")
        // App-owned foreground runs never self-update; the app updater owns runtime changes.
        .env("OPENCLAW_NO_AUTO_UPDATE", "1")
        .env("OPENCLAW_NO_RESPAWN", "1");
    Ok(command)
}

fn apply_service_request(
    pairing: &Pairing,
    service: bool,
    redactions: &mut Vec<String>,
    probe_owner: &mut Option<DesktopNodeProcess>,
    shared: &Mutex<Shared>,
    revision: u64,
) -> Result<Run, String> {
    *redactions = pairing.redactions.clone();
    let cli = OpenClawCli::locate().map_err(|_| {
        "Install or update the local OpenClaw CLI first, then try again.".to_string()
    })?;
    let args = pairing_arguments(&pairing.handoff, pairing.display_name.as_deref(), service);
    let cancelled = || {
        let shared = shared.lock().expect("executor state");
        shared.stopping || shared.revision != revision
    };
    let output = run_to_completion(&cli, &args, cancelled, probe_owner)?;
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(remediation(&stdout, &stderr)
            .map(String::from)
            .unwrap_or_else(|| {
                "Pairing did not finish. Check the join link and try again.".into()
            }));
    }
    probe_service_status(&cli, cancelled, probe_owner)?;
    Ok(Run {
        phase: Phase::Running,
        mode: Some("service"),
        service_installed: Some(true),
        detail: Some(String::from(
            "The background service is installed and running.",
        )),
    })
}

fn apply_tool_action(
    shared: &Mutex<Shared>,
    revision: u64,
    action: ToolAction,
    probe_owner: &mut Option<DesktopNodeProcess>,
) -> Result<Run, String> {
    let cli = OpenClawCli::locate().map_err(|_| {
        "Install or update the local OpenClaw CLI first, then try again.".to_string()
    })?;
    let args = service_arguments(action);
    let cancelled = || {
        let shared = shared.lock().expect("executor state");
        shared.stopping || shared.revision != revision
    };
    let output = run_to_completion(&cli, &args, cancelled, probe_owner)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(remediation("", &stderr)
            .map(String::from)
            .unwrap_or_else(|| "The service change did not finish. Try again.".into()));
    }
    // `node status` reports systemd enabled state, which stays true across
    // stop; the controller owns the running/stopped observation instead.
    Ok(Run {
        phase: if action == ToolAction::Stop {
            Phase::Off
        } else {
            Phase::Running
        },
        mode: Some("service"),
        service_installed: Some(true),
        detail: None,
    })
}

fn finish_tool_run(
    app: &AppHandle,
    shared: &Mutex<Shared>,
    revision: u64,
    outcome: Result<Run, String>,
    tail: &mut VecDeque<String>,
    mode: Option<&'static str>,
) {
    tail.clear();
    match outcome {
        Ok(run) => publish(app, shared, revision, run),
        Err(error) => publish(
            app,
            shared,
            revision,
            Run {
                phase: Phase::Error,
                mode,
                service_installed: None,
                detail: Some(error),
            },
        ),
    }
}

pub(crate) fn open_window(app: &AppHandle) -> Result<(), String> {
    // GTK window operations belong to the main thread even when IPC arrives
    // on an async worker.
    let (sender, receiver) = std::sync::mpsc::channel();
    let current = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(ensure_window(&current));
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .map_err(|_| "The controlled-device window did not open.".to_string())?
}

fn ensure_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window(EXECUTOR_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, EXECUTOR_LABEL, WebviewUrl::App("executor.html".into()))
        .title("Controlled Device")
        .inner_size(560.0, 680.0)
        .min_inner_size(460.0, 500.0)
        .build()
        .map_err(|error| format!("Could not open the controlled-device window: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn executor_node_request(app: AppHandle, message: Value) -> Result<Snapshot, String> {
    // Vault access (Secret Service) and window work must leave the async runtime.
    let current = app.clone();
    tauri::async_runtime::spawn_blocking(move || executor_node_message(&current, message))
        .await
        .map_err(|error| format!("The controlled-device request did not finish: {error}"))?
}

fn executor_node_message(app: &AppHandle, message: Value) -> Result<Snapshot, String> {
    let node = app.state::<ExecutorNode>();
    match message.get("type").and_then(Value::as_str) {
        Some("open") => open_window(app)?,
        Some("status") | Some("refresh") => node.refresh()?,
        Some("set-consent") => {
            let consent = message
                .get("value")
                .and_then(Value::as_bool)
                .ok_or("Consent must be true or false.")?;
            node.set_consent(consent)?;
        }
        Some("pair") => {
            let consent = message
                .get("consent")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !consent {
                return Err("Remote-control consent is required before pairing.".into());
            }
            node.set_consent(true)?;
            let target = message
                .get("target")
                .and_then(Value::as_str)
                .ok_or("Paste the join URL or setup code from the controlling Gateway.")?;
            let display_name = message.get("displayName").and_then(Value::as_str);
            let service = message
                .get("mode")
                .and_then(Value::as_str)
                .map(|mode| mode == "service")
                .unwrap_or(false);
            let root = app
                .path()
                .app_config_dir()
                .map_err(|error| error.to_string())?
                .join("executor-node");
            node.pair(target, display_name, service, &root)?;
        }
        Some("start") | Some("stop") | Some("restart") => {
            let action = match message.get("type").and_then(Value::as_str) {
                Some("start") => ToolAction::Start,
                Some("stop") => ToolAction::Stop,
                _ => ToolAction::Restart,
            };
            node.action(action)?;
        }
        _ => return Err("This controlled-device action is not available.".into()),
    }
    Ok(node.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_code(payload: serde_json::Value) -> String {
        format!(
            "oc-pair://{}",
            URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes())
        )
    }

    #[test]
    fn join_urls_and_setup_codes_validate_without_echoing_secrets() {
        let (_, redactions) =
            parse_target("https://gateway.example.com/j/abcdefghijklmnopqrstuv").unwrap();
        assert_eq!(redactions.len(), 1);
        let (_, redactions) = parse_target(&setup_code(serde_json::json!({
            "url": "wss://gateway.example.com",
            "bootstrapToken": "fixture-bootstrap-token",
        })))
        .unwrap();
        assert_eq!(redactions.len(), 3);
        assert!(redactions[1].starts_with("eyJ"));
        assert!(redactions[2] == "fixture-bootstrap-token");
        assert!(parse_target("").is_err());
        assert!(parse_target("not-a-url").is_err());
        assert!(parse_target("ftp://gateway.example.com/j/abcdefghijklmnopqrstuv").is_err());
        assert!(parse_target("http://gateway.example.com/j/abcdefghijklmnopqrstuv").is_err());
        assert!(parse_target("https://gateway.example.com/j/short").is_err());
        assert!(
            parse_target("https://user:pw@gateway.example.com/j/abcdefghijklmnopqrstuv").is_err()
        );
        assert!(parse_target("https://gateway.example.com/j/abcdefghijklmnopqrstuv?x=1").is_err());
    }

    #[test]
    fn loopback_http_join_urls_are_accepted() {
        parse_target("http://127.0.0.1:18789/j/abcdefghijklmnopqrstuv").unwrap();
        parse_target("http://localhost:18789/j/abcdefghijklmnopqrstuv").unwrap();
        parse_target("http://[::1]:18789/j/abcdefghijklmnopqrstuv").unwrap();
    }

    #[test]
    fn invalid_and_expired_setup_codes_are_refused() {
        let expired = setup_code(serde_json::json!({
            "url": "wss://gateway.example.com",
            "bootstrapToken": "fixture-token",
            "expiresAtMs": 1,
        }));
        let error = parse_target(&expired).unwrap_err();
        assert!(error.contains("expired"));
        assert!(!error.contains("fixture-token"));
        let wrong = setup_code(serde_json::json!({"url": "https://wrong", "bootstrapToken": "t"}));
        assert!(parse_target(&wrong).is_err());
        let no_token = setup_code(serde_json::json!({"url": "wss://gateway.example.com"}));
        assert!(parse_target(&no_token).is_err());
        assert!(parse_target("oc-pair://!!!").is_err());
        assert!(parse_target("oc-pair://bm90LWEtcGF5bG9hZA").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn handoff_files_are_private_and_removed_when_dropped() {
        use std::fs;
        let root = std::env::temp_dir().join(format!("executor-handoff-{}", uuid::Uuid::new_v4()));
        let path = {
            let handoff = TargetHandoff::write(
                &root,
                "https://gateway.example.com/j/abcdefghijklmnopqrstuv",
            )
            .unwrap();
            let metadata = handoff.path().metadata().unwrap();
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
            assert!(handoff.path().is_file());
            handoff.path().to_path_buf()
        };
        assert!(
            !path.exists(),
            "dropping the handoff must remove the secret"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn explicit_commands_keep_the_executor_profile_a_working_executor() {
        // An explicit --commands list REPLACES the executor profile defaults, so
        // the minimal surface must retain command execution and the whole
        // occupancy lease lifecycle on its own.
        for required in [
            "system.run",
            "system.execApprovals.get",
            "system.execApprovals.set",
            "occupancy.acquire.v1",
            "occupancy.renew.v1",
            "occupancy.release.v1",
            "occupancy.status.v1",
            "occupancy.revoke.v1",
        ] {
            assert!(
                EXECUTOR_COMMANDS.contains(&required),
                "the minimal executor surface lost {required}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn pairing_commands_carry_only_the_handoff_path_and_executor_selection() {
        use std::fs;
        let root = std::env::temp_dir().join(format!("executor-args-{}", uuid::Uuid::new_v4()));
        let secret = "oc-pair://c2VjcmV0LXBheWxvYWQ";
        let handoff = TargetHandoff::write(&root, secret).unwrap();
        let args = pairing_arguments(&handoff, Some("Desk"), true);
        let joined = args.join(" ");
        assert!(joined.contains("--executor"));
        assert!(joined.contains("--service"));
        assert!(joined.contains("--target-file"));
        assert!(joined.contains(&handoff.path().to_string_lossy().into_owned()));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--display-name", "Desk"]));
        let commands_index = args.iter().position(|arg| arg == "--commands").unwrap();
        assert_eq!(
            args[commands_index + 1],
            EXECUTOR_COMMANDS.join(","),
            "pairing must advertise the explicit minimal executor surface"
        );
        assert!(!joined.contains(secret));
        assert!(!joined.contains("c2VjcmV0"));
        let reconnect = reconnect_arguments();
        assert_eq!(
            reconnect,
            vec![
                "node".to_string(),
                "run".to_string(),
                "--executor".to_string()
            ]
        );
        assert_eq!(
            service_arguments(ToolAction::Restart),
            vec!["node".to_string(), "restart".to_string()]
        );
        drop(handoff);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn node_host_diagnostics_map_to_pairing_phases() {
        assert_eq!(
            classify_progress("node host gateway connected: wss://gateway.example.com"),
            Some(Phase::Running)
        );
        assert_eq!(
            classify_progress("node host gateway reconnect paused after close (4000): pairing required detail=PAIRING_REQUIRED; waiting for operator action"),
            Some(Phase::WaitingApproval)
        );
        assert_eq!(
            classify_progress("node host gateway reconnect paused after close (1006): no close reason; waiting for operator action"),
            Some(Phase::Preparing)
        );
        assert_eq!(
            classify_progress("node host gateway closed (1000): bye"),
            None
        );
    }

    #[test]
    fn diagnostics_are_sanitized_and_never_present_commands_or_secrets() {
        let secrets = vec![
            "https://gateway.example.com/j/abcdefghijklmnopqrstuv".into(),
            "raw-setup-code-payload".into(),
        ];
        assert_eq!(
            sanitize_diagnostic("auth raw-setup-code-payload seen", &secrets),
            Some("auth [redacted] seen".into())
        );
        assert_eq!(
            sanitize_diagnostic("run openclaw connect <join-url>", &secrets),
            None
        );
        assert_eq!(sanitize_diagnostic("   \n", &secrets), None);
        assert_eq!(
            sanitize_diagnostic("failed\u{7}bad", &secrets),
            Some("failedbad".into())
        );
    }

    #[test]
    fn cli_failures_map_to_command_free_remediation() {
        assert_eq!(
            remediation("", "Connect target is required. To pair this machine, mint a join URL on the Gateway host with openclaw devices join-code, then run: openclaw connect <join-url>"),
            Some("This computer is not paired yet. Paste a new join URL or setup code below.")
        );
        assert_eq!(
            remediation("Gateway join code was not found or has expired.", ""),
            Some("That join link expired or was already used. Ask for a fresh one.")
        );
        assert_eq!(
            remediation("", "Invalid pairing setup code or URL."),
            Some("That setup code could not be read. Copy the whole code and paste it again.")
        );
        assert_eq!(remediation("", "some other failure"), None);
    }

    #[test]
    fn service_status_json_reports_only_loaded_state() {
        let read = |stdout: &[u8]| -> Option<bool> {
            let output = Output {
                status: std::process::ExitStatus::default(),
                stdout: stdout.to_vec(),
                stderr: Vec::new(),
            };
            let value: Value = serde_json::from_slice(&output.stdout).unwrap();
            value
                .get("service")
                .and_then(|service| service.get("loaded"))
                .and_then(Value::as_bool)
        };
        assert_eq!(
            read(br#"{"service":{"label":"openclaw-node","loaded":true,"loadedText":"loaded"}}"#),
            Some(true)
        );
        assert_eq!(
            read(br#"{"service":{"label":"openclaw-node","loaded":false,"notLoadedText":"not installed"}}"#),
            Some(false)
        );
    }
}
