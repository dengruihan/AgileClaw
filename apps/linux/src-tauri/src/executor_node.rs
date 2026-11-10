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
use std::sync::atomic::{AtomicBool, Ordering};
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

/// The controller's own observation of the CLI-owned node service. `Unverified`
/// retains service authority after a failed action: Start/Restart keep routing
/// to the service until a probe reconciles the real state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ServiceState {
    Absent,
    Installed { running: Option<bool> },
    Unverified,
}

impl ServiceState {
    fn installed(&self) -> Option<bool> {
        match self {
            Self::Absent => Some(false),
            Self::Installed { .. } | Self::Unverified => None,
        }
    }

    fn running(&self) -> Option<bool> {
        match self {
            Self::Installed { running } => *running,
            _ => None,
        }
    }

    fn may_exist(&self) -> bool {
        !matches!(self, Self::Absent)
    }
}

#[derive(Clone, Debug)]
struct Run {
    phase: Phase,
    mode: Option<&'static str>,
    service: ServiceState,
    paired: Option<bool>,
    detail: Option<String>,
}

impl Run {
    fn idle(service: ServiceState, paired: Option<bool>) -> Self {
        Self {
            phase: Phase::Off,
            mode: None,
            service,
            paired,
            detail: None,
        }
    }

    fn error(self, detail: String) -> Self {
        Self {
            phase: Phase::Error,
            detail: Some(detail),
            ..self
        }
    }
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub revision: u64,
    pub phase: &'static str,
    pub mode: Option<&'static str>,
    pub service_installed: Option<bool>,
    pub service_running: Option<bool>,
    pub paired: Option<bool>,
    pub detail: Option<String>,
    pub cli_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

impl Snapshot {
    /// Run-state fields always serialize (as null when cleared) so the window
    /// can replace them wholesale; only the app preferences are omitted.
    fn from_run(revision: u64, run: &Run, cli_available: bool) -> Self {
        Self {
            revision,
            phase: run.phase.as_str(),
            mode: run.mode,
            service_installed: run.service.installed(),
            service_running: run.service.running(),
            paired: run.paired,
            detail: run.detail.clone(),
            cli_available,
            consent: None,
            display_name: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ToolAction {
    Start,
    Stop,
    Restart,
}

#[derive(Clone, Debug)]
enum Request {
    Idle,
    Foreground { pairing: Option<Pairing> },
    ServiceInstall(Pairing),
    Service(ToolAction),
}

/// The supervisor's active owner, used to decide what Stop must join first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActiveRequest {
    Idle,
    Service,
    PairingChild,
}

impl Request {
    fn active_kind(&self) -> ActiveRequest {
        match self {
            Self::Service(_) => ActiveRequest::Service,
            Self::Foreground { .. } | Self::ServiceInstall(_) => ActiveRequest::PairingChild,
            Self::Idle => ActiveRequest::Idle,
        }
    }
}

/// Pairing request progress. `Preparing` covers the serialized old-service
/// stop and command build, before any replacement child exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PairingStage {
    None,
    Preparing,
    Child,
}

/// Whether a spawned pairing child still belongs to the applied request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SpawnedChildGeneration {
    Current,
    Stale,
}

/// What Stop means for the current run and in-flight request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopTarget {
    /// Drop to Idle: join/cancel an app-owned pairing or install child.
    CancelOwnedChild,
    /// Join/cancel the in-flight action, then run the real service stop.
    ServiceStop,
    /// Stop the app-owned foreground node.
    ForegroundChild,
    Idle,
}

/// Which supervised child occupies the single child slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChildRole {
    ForegroundRun,
    ServiceInstall,
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
    pairing_stage: PairingStage,
    stopping: bool,
    status_revision: u64,
    status: Run,
    cli_available: bool,
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
    let loopback = matches!(url.host_str(), Some("localhost"))
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
    let Some((_, code)) = url.path().rsplit_once("/j/") else {
        return Err("Paste the whole join URL, ending in /j/<code>.".into());
    };
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

/// Reconnect always restates the fixed minimal surface; without an explicit
/// list `node run --executor` would advertise the full executor profile.
fn reconnect_arguments() -> Vec<String> {
    vec![
        "node".into(),
        "run".into(),
        "--executor".into(),
        "--commands".into(),
        EXECUTOR_COMMANDS.join(","),
    ]
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

fn pairing_probe_arguments() -> Vec<String> {
    vec!["node".into(), "pairing".into(), "--json".into()]
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

fn cli_missing_error() -> String {
    "Install the OpenClaw CLI first, then try again.".to_string()
}

/// The user-facing meaning of one CLI service observation. A confirmed absent
/// service clears the detail; only an unverified or unrecognized observation
/// is described as unknown.
fn service_detail(cli_available: bool, service: &ServiceState) -> Option<String> {
    if !cli_available {
        return Some(cli_missing_error());
    }
    match service {
        ServiceState::Absent => None,
        ServiceState::Installed {
            running: Some(true),
        } => Some(String::from(
            "The background service is installed and running.",
        )),
        ServiceState::Installed {
            running: Some(false),
        } => Some(String::from("The service is stopped.")),
        ServiceState::Installed { running: None } | ServiceState::Unverified => {
            Some(String::from("Service status is unknown."))
        }
    }
}

fn consent_missing_error() -> String {
    "Approve remote control before starting the controlled device.".to_string()
}

fn pairing_missing_error() -> String {
    "This computer is not paired yet. Pair with a join URL or setup code first.".to_string()
}

/// Record a freshly spawned pairing child when the request is still current.
/// A stale generation keeps the process owned by the supervisor; the caller
/// returns to the loop head, which joins it before applying the replacement.
fn note_spawned_pairing_child(shared: &Mutex<Shared>, revision: u64) -> SpawnedChildGeneration {
    let mut current = shared.lock().expect("executor state");
    if current.stopping || current.revision != revision {
        SpawnedChildGeneration::Stale
    } else {
        current.pairing_stage = PairingStage::Child;
        SpawnedChildGeneration::Current
    }
}

/// Join every owned process before the supervisor applies another request.
/// A failed teardown retains that exact owner and reports the error; callers
/// must not start a replacement until a later retry joins it.
fn join_owned_processes(
    child: &mut Option<DesktopNodeProcess>,
    probe: &mut Option<DesktopNodeProcess>,
) -> Option<String> {
    let mut failure = None;
    for owner in [child, probe] {
        if let Some(process) = owner.as_mut() {
            if let Err(error) = process.stop() {
                failure = Some(error);
                continue;
            }
        }
        *owner = None;
    }
    failure
}

/// Decide what Stop means for the current run and the supervisor's active
/// request. An app-owned pairing/install child is cancellable; a service
/// action in flight must be joined and then stopped through the service.
fn stop_target(run: &Run, request: ActiveRequest, pairing_stage: PairingStage) -> StopTarget {
    if request == ActiveRequest::Service {
        return StopTarget::ServiceStop;
    }
    if request == ActiveRequest::PairingChild {
        // A replacement pairing first stops any old service; no child exists
        // yet. Stop must join that preparation and stop the service for real,
        // not just cancel it. Once the pairing child is owned, cancelling and
        // joining that child is the revocation.
        if pairing_stage == PairingStage::Preparing {
            return StopTarget::ServiceStop;
        }
        if pairing_stage == PairingStage::Child {
            return StopTarget::CancelOwnedChild;
        }
        // No pairing work started yet; fall through to the current run state.
    }
    let cancels_owned_child = matches!(run.phase, Phase::Preparing | Phase::WaitingApproval)
        && (run.mode == Some("foreground")
            || (run.mode == Some("service") && run.service == ServiceState::Unverified));
    if cancels_owned_child {
        return StopTarget::CancelOwnedChild;
    }
    if run.mode == Some("foreground") {
        return StopTarget::ForegroundChild;
    }
    if run.service.may_exist() && run.mode == Some("service") {
        return StopTarget::ServiceStop;
    }
    StopTarget::Idle
}

pub(crate) struct ExecutorNode {
    shared: Arc<Mutex<Shared>>,
    profiles: Arc<GatewayProfiles>,
    sender: mpsc::SyncSender<()>,
    worker: Mutex<Option<JoinHandle<()>>>,
    /// Serializes CLI installs at the owner: a second concurrent request is
    /// rejected instead of racing two installers over one prefix.
    installing: AtomicBool,
}

impl ExecutorNode {
    pub fn start(app: AppHandle, profiles: Arc<GatewayProfiles>) -> Result<Self, String> {
        let shared = Arc::new(Mutex::new(Shared {
            revision: 0,
            request: Request::Idle,
            pairing_stage: PairingStage::None,
            stopping: false,
            status_revision: 0,
            status: Run {
                phase: Phase::Off,
                mode: None,
                service: ServiceState::Unverified,
                paired: None,
                detail: None,
            },
            cli_available: OpenClawCli::discover().is_ok(),
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
            installing: AtomicBool::new(false),
        })
    }

    /// Serialize CLI installs at the owner: exactly one installer may run
    /// against the prefix, and a racing request is rejected, not queued.
    fn begin_install(&self) -> Result<(), String> {
        self.installing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| ())
            .map_err(|_| "A CLI install is already running. Wait for it to finish.".to_string())
    }

    fn end_install(&self) {
        self.installing.store(false, Ordering::SeqCst);
    }

    pub fn snapshot(&self) -> Snapshot {
        let (revision, run, cli_available) = {
            let shared = self.shared.lock().expect("executor state");
            (
                shared.status_revision,
                shared.status.clone(),
                shared.cli_available,
            )
        };
        let mut snapshot = Snapshot::from_run(revision, &run, cli_available);
        snapshot.consent = self.profiles.executor_consent().ok().flatten();
        snapshot.display_name = self.profiles.executor_display_name().ok().flatten();
        snapshot
    }

    /// Probe the service and canonical pairing so a fresh window or tray
    /// reflects durable state. The caller's thread probes inline (it already
    /// left the async runtime), and the observation is refused while another
    /// request owns the supervisor so it cannot stomp a live run.
    pub fn refresh(&self, app: &AppHandle) -> Result<(), String> {
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
        probe_now(app, &self.shared)
    }

    /// Stage the pairing secret at 0600 and hand the path to the CLI. The
    /// secret itself never reaches argv, env, logs, or service definitions.
    /// Replacing a live service is serialized here: the supervisor stops and
    /// reconciles the old service before any replacement runs.
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

    pub fn set_consent(&self, consent: bool) -> Result<(), String> {
        self.profiles.set_executor_consent(consent)
    }

    /// Tray and window controls share this dispatch. Consent gates every
    /// start; canonical pairing evidence gates reconnects; service authority
    /// is retained until reconciled away.
    pub fn action(&self, action: ToolAction) -> Result<(), String> {
        let (request, needs_pairing_probe) = {
            let shared = self
                .shared
                .lock()
                .map_err(|_| "Controlled device unavailable.")?;
            let run = &shared.status;
            let consented = self.profiles.executor_consent().ok().flatten() == Some(true);
            match action {
                // Stopping a running device must work without consent — that is
                // how consent withdrawal takes effect. A submitted service
                // Start/Restart still owns the CLI action until the next request
                // is applied, so Stop must join it and then run the real service
                // stop instead of cancelling to an observation-only Idle pass.
                ToolAction::Stop => (
                    match stop_target(run, shared.request.active_kind(), shared.pairing_stage) {
                        StopTarget::ServiceStop => Request::Service(ToolAction::Stop),
                        StopTarget::CancelOwnedChild
                        | StopTarget::ForegroundChild
                        | StopTarget::Idle => Request::Idle,
                    },
                    false,
                ),
                // Only Start/Restart are consent-gated; the service's own
                // context is the authority for service actions (pairing
                // evidence gates only the foreground reconnect below).
                ToolAction::Start | ToolAction::Restart => {
                    if !consented {
                        return Err(consent_missing_error());
                    }
                    if run.service.may_exist() && run.mode == Some("service") {
                        (Request::Service(action), false)
                    } else {
                        match run.paired {
                            Some(true) => (Request::Foreground { pairing: None }, false),
                            Some(false) => return Err(pairing_missing_error()),
                            // A fresh process may not have reconciled canonical
                            // pairing yet. Revalidate through the CLI owner
                            // immediately before the side effect.
                            None => (Request::Foreground { pairing: None }, true),
                        }
                    }
                }
            }
        };
        if needs_pairing_probe {
            let (paired, generation) = self.revalidate_pairing()?;
            if !paired {
                return Err(pairing_missing_error());
            }
            return self.submit_at_generation(request, generation);
        }
        self.submit(request)
    }

    /// Read the CLI-owned canonical pairing fact on the caller's thread. The
    /// result is fenced by the request generation: a supervisor transition
    /// during the probe refuses the stale answer instead of starting on it.
    fn revalidate_pairing(&self) -> Result<(bool, u64), String> {
        let (revision, cli) = {
            let shared = self
                .shared
                .lock()
                .map_err(|_| "Controlled device unavailable.")?;
            if shared.stopping {
                return Err("OpenClaw is quitting.".into());
            }
            (shared.revision, OpenClawCli::locate().ok())
        };
        let cli = cli.ok_or_else(cli_missing_error)?;
        let cancelled = || {
            let shared = self.shared.lock().expect("executor state");
            shared.stopping || shared.revision != revision
        };
        let mut probe_owner = None;
        let paired = probe_paired(&cli, cancelled, &mut probe_owner)?;
        if let Some(mut process) = probe_owner {
            let _ = process.stop();
        }
        let mut current = self
            .shared
            .lock()
            .map_err(|_| "Controlled device unavailable.")?;
        if current.stopping || current.revision != revision {
            return Err("The controlled-device state changed. Try again.".into());
        }
        current.status.paired = paired;
        current.status_revision += 1;
        Ok((paired == Some(true), revision))
    }

    fn submit(&self, request: Request) -> Result<(), String> {
        self.submit_with_generation(request, None)
    }

    /// Submit only if the supervisor generation is still the one the caller
    /// revalidated against, so a stale pairing answer cannot start a request.
    fn submit_at_generation(&self, request: Request, generation: u64) -> Result<(), String> {
        self.submit_with_generation(request, Some(generation))
    }

    fn submit_with_generation(
        &self,
        request: Request,
        expected_generation: Option<u64>,
    ) -> Result<(), String> {
        {
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| "Controlled device unavailable.")?;
            if shared.stopping {
                return Err("OpenClaw is quitting.".into());
            }
            if expected_generation.is_some_and(|expected| shared.revision != expected) {
                return Err("The controlled-device state changed. Try again.".into());
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
        Snapshot::from_run(
            current.status_revision,
            &current.status,
            current.cli_available,
        )
    };
    crate::tray::publish_executor(app, &snapshot);
    let _ = app.emit_to(EXECUTOR_LABEL, STATUS_EVENT, snapshot);
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

/// Read the CLI-owned service state. Nonzero or unreadable status is an
/// explicit unknown, never a silent "absent".
fn probe_service_state(
    cli: &OpenClawCli,
    cancelled: impl Fn() -> bool,
    probe_owner: &mut Option<DesktopNodeProcess>,
) -> Result<ServiceState, String> {
    let output = run_to_completion(cli, &status_arguments(), cancelled, probe_owner)?;
    if !output.status.success() {
        return Ok(ServiceState::Unverified);
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "The CLI returned an invalid controlled-device service status.".to_string())?;
    let service = value.get("service");
    let installed = service
        .and_then(|service| service.get("loaded"))
        .and_then(Value::as_bool);
    match installed {
        Some(false) => Ok(ServiceState::Absent),
        Some(true) => {
            let running = service
                .and_then(|service| service.get("runtime"))
                .and_then(|runtime| runtime.get("status"))
                .and_then(Value::as_str)
                .and_then(|status| match status {
                    "running" => Some(true),
                    "stopped" => Some(false),
                    _ => None,
                });
            Ok(ServiceState::Installed { running })
        }
        None => Ok(ServiceState::Unverified),
    }
}

/// The CLI owns the canonical pairing decision (saved nodeHost.config row plus
/// device identity and a reusable node token). The app only reads its boolean.
fn parse_pairing_probe(stdout: &[u8]) -> Result<bool, String> {
    let value: Value = serde_json::from_slice(stdout)
        .map_err(|_| "The CLI returned an invalid controlled-device pairing status.".to_string())?;
    value
        .get("resumable")
        .and_then(Value::as_bool)
        .ok_or_else(|| "The CLI returned an invalid controlled-device pairing status.".to_string())
}

/// Detect canonical pairing without touching credentials or SQLite directly.
fn probe_paired(
    cli: &OpenClawCli,
    cancelled: impl Fn() -> bool,
    probe_owner: &mut Option<DesktopNodeProcess>,
) -> Result<Option<bool>, String> {
    let output = run_to_completion(cli, &pairing_probe_arguments(), cancelled, probe_owner)?;
    if output.status.success() {
        return parse_pairing_probe(&output.stdout).map(Some);
    }
    // A failed read is an explicit unknown, never a silent "not paired".
    Ok(None)
}

fn tail_text(tail: &VecDeque<String>) -> String {
    tail.iter().cloned().collect::<Vec<_>>().join("\n")
}

/// Reconcile the CLI-owned service state and canonical pairing evidence into
/// the shared run state. Callers already run off the async runtime; the write
/// is revision-guarded so a superseded probe never overwrites newer state.
fn probe_now(app: &AppHandle, shared: &Arc<Mutex<Shared>>) -> Result<(), String> {
    {
        let current = shared.lock().expect("executor state");
        if current.stopping || !matches!(current.request, Request::Idle) {
            return Ok(());
        }
    }
    let revision = shared.lock().expect("executor state").revision;
    let cancelled = || {
        let current = shared.lock().expect("executor state");
        current.stopping || current.revision != revision
    };
    let mut probe_owner = None;
    let (cli, paired) = probe_knowledge(cancelled, &mut probe_owner);
    let service = match &cli {
        None => ServiceState::Unverified,
        Some(cli) => probe_service_state(cli, cancelled, &mut probe_owner)
            .unwrap_or(ServiceState::Unverified),
    };
    {
        let mut current = shared.lock().expect("executor state");
        current.cli_available = cli.is_some();
    }
    let run = Run {
        phase: match service.running() {
            Some(true) => Phase::Running,
            _ => Phase::Off,
        },
        // No service authority is claimed while the CLI is missing; only a
        // reconciled service enables it.
        mode: (cli.is_some() && service.may_exist()).then_some("service"),
        service,
        paired,
        detail: service_detail(cli.is_some(), &service),
    };
    publish(app, shared, revision, run);
    Ok(())
}

/// What the supervisor knows about the CLI up front: a verified CLI plus the
/// canonical pairing evidence probe.
fn probe_knowledge(
    cancelled: impl Fn() -> bool,
    probe_owner: &mut Option<DesktopNodeProcess>,
) -> (Option<OpenClawCli>, Option<bool>) {
    match OpenClawCli::discover() {
        Err(_) => (None, None),
        Ok(cli) => {
            let paired = probe_paired(&cli, cancelled, probe_owner).unwrap_or(None);
            (Some(cli), paired)
        }
    }
}

fn run(app: AppHandle, shared: Arc<Mutex<Shared>>, receiver: mpsc::Receiver<()>) {
    let mut child: Option<DesktopNodeProcess> = None;
    let mut child_role: Option<ChildRole> = None;
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
            // Join every owned process before any replacement or shutdown. A
            // failed teardown retains that exact owner and the supervisor
            // retries it before applying the next request.
            if let Some(error) = join_owned_processes(&mut child, &mut probe_owner) {
                let run = {
                    let current = shared.lock().expect("executor state");
                    current.status.clone().error(error)
                };
                publish(&app, &shared, revision, run);
                let _ = receiver.recv_timeout(Duration::from_secs(1));
                continue;
            }
            child_role = None;
            if stopping {
                break;
            }
            applied = Some(revision);
            tail.clear();
            {
                let mut current = shared.lock().expect("executor state");
                current.pairing_stage = PairingStage::None;
            }
            let cancelled = || {
                let shared = shared.lock().expect("executor state");
                shared.stopping || shared.revision != revision
            };
            match request {
                Request::Idle => {
                    // Reconcile the CLI-owned service and canonical pairing
                    // before publishing idle state so a fresh process (for
                    // example after relaunch) can start from the tray without
                    // opening the window, and the next Start dispatches against
                    // facts rather than a retained unknown.
                    let cli = OpenClawCli::locate().ok();
                    let cancelled = || {
                        let shared = shared.lock().expect("executor state");
                        shared.stopping || shared.revision != revision
                    };
                    let service = match &cli {
                        None => ServiceState::Unverified,
                        Some(cli) => probe_service_state(cli, cancelled, &mut probe_owner)
                            .unwrap_or(ServiceState::Unverified),
                    };
                    let paired = match &cli {
                        None => None,
                        Some(cli) => probe_paired(cli, cancelled, &mut probe_owner).unwrap_or(None),
                    };
                    {
                        let mut current = shared.lock().expect("executor state");
                        current.cli_available = cli.is_some();
                    }
                    let run = Run {
                        phase: match service.running() {
                            Some(true) => Phase::Running,
                            _ => Phase::Off,
                        },
                        // No service authority is claimed while the CLI is
                        // missing; only a reconciled service enables it.
                        mode: (cli.is_some() && service.may_exist()).then_some("service"),
                        service,
                        paired,
                        detail: service_detail(cli.is_some(), &service),
                    };
                    publish(&app, &shared, revision, run);
                }
                Request::Foreground { pairing } => {
                    if let Some((process, role, generation)) = start_pairing_request(
                        &app,
                        &shared,
                        revision,
                        cancelled,
                        pairing,
                        false,
                        &mut redactions,
                        &mut probe_owner,
                    ) {
                        child = Some(process);
                        child_role = Some(role);
                        if generation == SpawnedChildGeneration::Stale || cancelled() {
                            // Ownership transferred: go straight to the loop
                            // head, which joins this exact child (retaining it
                            // on failure) before applying the superseding
                            // request.
                            continue;
                        }
                    }
                }
                Request::ServiceInstall(pairing) => {
                    if let Some((process, role, generation)) = start_pairing_request(
                        &app,
                        &shared,
                        revision,
                        cancelled,
                        Some(pairing),
                        true,
                        &mut redactions,
                        &mut probe_owner,
                    ) {
                        child = Some(process);
                        child_role = Some(role);
                        if generation == SpawnedChildGeneration::Stale || cancelled() {
                            continue;
                        }
                    }
                }
                Request::Service(action) => {
                    publish(
                        &app,
                        &shared,
                        revision,
                        Run {
                            phase: Phase::Preparing,
                            mode: Some("service"),
                            service: ServiceState::Unverified,
                            paired: None,
                            detail: Some(String::from("Applying the service change.")),
                        },
                    );
                    redactions.clear();
                    let outcome = match OpenClawCli::locate() {
                        Err(_) => Err(cli_missing_error()),
                        Ok(cli) => {
                            apply_tool_action(&cli, &shared, revision, action, &mut probe_owner)
                        }
                    };
                    finish_tool_run(&app, &shared, revision, outcome, &mut tail);
                }
            }
        }
        if let (Some(process), Some(role)) = (child.as_mut(), child_role) {
            if let Some(phase) = drain_output(process, &redactions, &mut tail) {
                // The install child's authenticated hello precedes the actual
                // installation; it stays Preparing until the install exit and
                // running probe prove the service.
                let phase = match (role, phase) {
                    (ChildRole::ServiceInstall, Phase::Running) => Phase::Preparing,
                    (_, phase) => phase,
                };
                let changed = {
                    let mut current = shared.lock().expect("executor state");
                    if current.revision == revision && current.status.phase != phase {
                        current.status.phase = phase;
                        current.status.detail = Some(match (role, phase) {
                            (_, Phase::Running) => {
                                String::from("Connected. This computer is under remote control.")
                            }
                            (_, Phase::WaitingApproval) => {
                                String::from("Waiting for approval on the controlling Gateway.")
                            }
                            (ChildRole::ServiceInstall, _) => {
                                String::from("Pairing and installing the service.")
                            }
                            _ => String::from("Connecting this computer."),
                        });
                        if phase == Phase::Running && role == ChildRole::ForegroundRun {
                            // The first authenticated hello saved the canonical
                            // pairing; a connected run is itself the evidence.
                            current.status.paired = Some(true);
                        }
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
                Ok(None) => {}
                outcome => {
                    // Join the whole tree before the slot is reusable; a
                    // failed join retains the owner for the next tick.
                    let joined = process.stop();
                    if let Err(join_error) = joined {
                        let run = {
                            let current = shared.lock().expect("executor state");
                            current.status.clone().error(format!(
                                "The controlled device could not finish stopping its process tree: {join_error}"
                            ))
                        };
                        publish(&app, &shared, revision, run);
                        let _ = receiver.recv_timeout(Duration::from_millis(250));
                        continue;
                    }
                    let exit_ok = matches!(&outcome, Ok(Some(status)) if status.success());
                    match role {
                        ChildRole::ForegroundRun => {
                            let text = tail_text(&tail);
                            let run = match &outcome {
                                Err(error) => {
                                    let current = shared.lock().expect("executor state");
                                    Run::idle(current.status.service, current.status.paired)
                                        .error(error.clone())
                                }
                                Ok(Some(_)) => {
                                    let current = shared.lock().expect("executor state");
                                    Run::idle(current.status.service, current.status.paired)
                                        .error(
                                            remediation("", &text).map(String::from).unwrap_or_else(|| {
                                                String::from(
                                                    "The controlled device stopped unexpectedly. Start it again or pair below.",
                                                )
                                            }),
                                        )
                                }
                                Ok(None) => unreachable!("exited() reported an exit"),
                            };
                            publish(&app, &shared, revision, run);
                        }
                        ChildRole::ServiceInstall => {
                            redactions.clear();
                            let outcome = if exit_ok {
                                match OpenClawCli::locate() {
                                    Err(_) => Err(cli_missing_error()),
                                    Ok(cli) => probe_service_state(
                                        &cli,
                                        || {
                                            let shared = shared.lock().expect("executor state");
                                            shared.stopping || shared.revision != revision
                                        },
                                        &mut probe_owner,
                                    )
                                    .and_then(|service| {
                                        if service.running() != Some(true) {
                                            return Err(String::from(
                                                "The service finished installing but is not running. Start it from here.",
                                            ));
                                        }
                                        Ok(Run {
                                            phase: Phase::Running,
                                            mode: Some("service"),
                                            service,
                                            paired: Some(true),
                                            detail: Some(String::from(
                                                "The background service is installed and running.",
                                            )),
                                        })
                                    })
                                }
                            } else {
                                let text = tail_text(&tail);
                                Err(remediation("", &text).map(String::from).unwrap_or_else(|| {
                                    "Pairing did not finish. Check the join link and try again."
                                        .into()
                                }))
                            };
                            finish_tool_run(&app, &shared, revision, outcome, &mut tail);
                        }
                    }
                    child = None;
                    child_role = None;
                    {
                        let mut current = shared.lock().expect("executor state");
                        current.pairing_stage = PairingStage::None;
                    }
                }
            }
        }
        let _ = receiver.recv_timeout(Duration::from_millis(250));
    }
}

/// Publish the preparing state, stop and reconcile any possibly-installed
/// service, and spawn the supervised pairing child. Errors publish retained
/// authority and return None; a spawn returns the owned child and its role.
fn start_pairing_request(
    app: &AppHandle,
    shared: &Arc<Mutex<Shared>>,
    revision: u64,
    cancelled: impl Fn() -> bool + Copy,
    pairing: Option<Pairing>,
    service_install: bool,
    redactions: &mut Vec<String>,
    probe_owner: &mut Option<DesktopNodeProcess>,
) -> Option<(DesktopNodeProcess, ChildRole, SpawnedChildGeneration)> {
    let mode = if service_install {
        "service"
    } else {
        "foreground"
    };
    {
        let mut current = shared.lock().expect("executor state");
        if current.revision == revision && !current.stopping {
            current.pairing_stage = PairingStage::Preparing;
        }
    }
    publish(
        app,
        shared,
        revision,
        Run {
            phase: Phase::Preparing,
            mode: Some(mode),
            service: ServiceState::Unverified,
            paired: None,
            detail: Some(String::from(if service_install {
                "Pairing and installing the service."
            } else {
                "Connecting this computer."
            })),
        },
    );
    // Serialized replacement: a possibly-installed service is stopped and
    // reconciled before any replacement runs, and a failed stop retains
    // service authority over the request.
    match prepare_pairing_request(
        shared,
        revision,
        cancelled,
        probe_owner,
        service_install,
        &pairing,
        redactions,
    ) {
        Err(run) => {
            publish(app, shared, revision, run);
            None
        }
        Ok(command) => {
            // A superseding Stop cancels the preparation before any
            // replacement (and its staged secret) can start.
            if cancelled() {
                return None;
            }
            match DesktopNodeProcess::spawn(command) {
                Ok(process) => {
                    // Ownership always transfers to the supervisor. Even if
                    // the generation changed while spawning, this exact child
                    // is installed in the supervised slot so the loop head
                    // joins it (retaining it on failure) before any
                    // replacement is applied.
                    let generation = note_spawned_pairing_child(shared, revision);
                    Some((
                        process,
                        if service_install {
                            ChildRole::ServiceInstall
                        } else {
                            ChildRole::ForegroundRun
                        },
                        generation,
                    ))
                }
                Err(error) => {
                    let run = {
                        let current = shared.lock().expect("executor state");
                        current.status.clone().error(error)
                    };
                    publish(app, shared, revision, run);
                    None
                }
            }
        }
    }
}

/// Stop and reconcile any possibly-installed service before a replacement
/// pairing. A failed stop returns the retained-authority run to publish and
/// aborts the replacement.
fn prepare_pairing_request(
    shared: &Arc<Mutex<Shared>>,
    revision: u64,
    cancelled: impl Fn() -> bool + Copy,
    probe_owner: &mut Option<DesktopNodeProcess>,
    service_install: bool,
    pairing: &Option<Pairing>,
    redactions: &mut Vec<String>,
) -> Result<std::process::Command, Run> {
    let mut service = shared.lock().expect("executor state").status.service;
    if service.may_exist() {
        let cli = OpenClawCli::locate().map_err(|_| Run {
            phase: Phase::Error,
            mode: Some("service"),
            service,
            paired: None,
            detail: Some(cli_missing_error()),
        })?;
        let stopped = apply_tool_action(&cli, shared, revision, ToolAction::Stop, probe_owner);
        service = match stopped {
            Ok(run) => run.service,
            Err(_) => {
                // The stop itself can fail because no service exists (for
                // example after a canceled install); reconcile the real state
                // before deciding whether authority is retained.
                probe_service_state(&cli, cancelled, probe_owner)
                    .unwrap_or(ServiceState::Unverified)
            }
        };
        if service.may_exist() && service.running() != Some(false) {
            return Err(Run {
                phase: Phase::Error,
                mode: Some("service"),
                service,
                paired: None,
                detail: Some(String::from(
                    "The previous service did not stop, so no replacement was started.",
                )),
            });
        }
    }
    let cli = OpenClawCli::locate().map_err(|_| Run {
        phase: Phase::Error,
        mode: Some(if service_install {
            "service"
        } else {
            "foreground"
        }),
        service,
        paired: None,
        detail: Some(cli_missing_error()),
    })?;
    let args = match pairing {
        Some(pairing) => {
            *redactions = pairing.redactions.clone();
            pairing_arguments(
                &pairing.handoff,
                pairing.display_name.as_deref(),
                service_install,
            )
        }
        None => {
            redactions.clear();
            reconnect_arguments()
        }
    };
    let mut command = cli.command(args).map_err(|error| Run {
        phase: Phase::Error,
        mode: Some(if service_install {
            "service"
        } else {
            "foreground"
        }),
        service,
        paired: None,
        detail: Some(error.to_string()),
    })?;
    command
        .env_remove("CF_ACCESS_CLIENT_ID")
        .env_remove("CF_ACCESS_CLIENT_SECRET")
        // App-owned foreground runs never self-update; the app updater owns runtime changes.
        .env("OPENCLAW_NO_AUTO_UPDATE", "1")
        .env("OPENCLAW_NO_RESPAWN", "1");
    Ok(command)
}

fn apply_tool_action(
    cli: &OpenClawCli,
    shared: &Mutex<Shared>,
    revision: u64,
    action: ToolAction,
    probe_owner: &mut Option<DesktopNodeProcess>,
) -> Result<Run, String> {
    let args = service_arguments(action);
    let cancelled = || {
        let shared = shared.lock().expect("executor state");
        shared.stopping || shared.revision != revision
    };
    let output = run_to_completion(cli, &args, cancelled, probe_owner)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(remediation("", &stderr)
            .map(String::from)
            .unwrap_or_else(|| "The service change did not finish. Try again.".into()));
    }
    // The phase comes from the probed runtime facts, never from the verb: a
    // start whose probe says stopped/unknown must not claim Running.
    let service = probe_service_state(cli, cancelled, probe_owner)?;
    let phase = match service.running() {
        Some(true) => Phase::Running,
        Some(false) => Phase::Off,
        None => {
            return Ok(Run {
                phase: Phase::Error,
                mode: Some("service"),
                service,
                paired: None,
                detail: Some(String::from(
                    "The service state could not be confirmed. Start or stop it again from here.",
                )),
            });
        }
    };
    Ok(Run {
        phase,
        mode: Some("service"),
        service,
        paired: None,
        detail: None,
    })
}

fn finish_tool_run(
    app: &AppHandle,
    shared: &Mutex<Shared>,
    revision: u64,
    outcome: Result<Run, String>,
    tail: &mut VecDeque<String>,
) {
    tail.clear();
    match outcome {
        Ok(run) => publish(app, shared, revision, run),
        Err(error) => {
            let run = {
                let current = shared.lock().expect("executor state");
                current.status.clone().error(error)
            };
            publish(app, shared, revision, run);
        }
    }
}

pub(crate) fn open_window(app: &AppHandle) -> Result<(), String> {
    // GTK window operations belong to the main thread even when IPC arrives
    // on a blocking worker.
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

/// Tray actions mirror the window's controls; a missing CLI becomes a visible
/// notification instead of a silent no-op.
pub(crate) fn submit_tray_action(app: &AppHandle, action: ToolAction) {
    let node = app.state::<ExecutorNode>();
    if let Err(error) = node.action(action) {
        eprintln!("Controlled device action failed: {error}");
        crate::notify::notify(app, "Controlled device", &error);
    }
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
    // Vault access (Secret Service), GTK windows, and CLI installs must leave
    // the async runtime.
    let current = app.clone();
    tauri::async_runtime::spawn_blocking(move || executor_node_message(&current, message))
        .await
        .map_err(|error| format!("The controlled-device request did not finish: {error}"))?
}

fn executor_node_message(app: &AppHandle, message: Value) -> Result<Snapshot, String> {
    let node = app.state::<ExecutorNode>();
    match message.get("type").and_then(Value::as_str) {
        Some("open") => open_window(app)?,
        Some("status") | Some("refresh") => node.refresh(app)?,
        Some("set-consent") => {
            let consent = message
                .get("value")
                .and_then(Value::as_bool)
                .ok_or("Consent must be true or false.")?;
            node.set_consent(consent)?;
        }
        Some("install-cli") => {
            let channel: crate::installer::InstallChannel =
                serde_json::from_value(message.get("channel").cloned().unwrap_or(Value::Null))
                    .map_err(|_| "Choose a release channel for the CLI.".to_string())?;
            node.begin_install()?;
            let result = (|| {
                // CLI-only install: no Gateway service, runtime binding, or
                // dashboard admission belongs to the controlled-device flow.
                // Installer errors carry raw tool output (including command-
                // shaped remediation), so the window only ever receives
                // app-authored guidance; structured steps stream separately.
                crate::installer::install(app, channel, true)
                    .map_err(|_| {
                        "The CLI install did not finish. Try again, or check the install log in the OpenClaw window.".to_string()
                    })
                    .and_then(|()| {
                        OpenClawCli::discover()
                            .map(|_| ())
                            .map_err(|_| "The CLI was installed but could not be started. Try again.".to_string())
                    })?;
                node.refresh(app)
            })();
            node.end_install();
            result?;
        }
        Some("pair") => {
            let consent = message
                .get("consent")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !consent || node.snapshot().consent != Some(true) {
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
        // Reconnect restates the same fixed surface; without it `node run
        // --executor` would advertise the full executor profile.
        let reconnect = reconnect_arguments();
        let commands_index = reconnect
            .iter()
            .position(|arg| arg == "--commands")
            .unwrap();
        assert_eq!(reconnect[commands_index + 1], EXECUTOR_COMMANDS.join(","));
        assert!(!reconnect.iter().any(|arg| arg.contains(secret)));
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
    fn service_status_maps_running_stopped_and_unknown_explicitly() {
        let read = |stdout: &[u8]| -> ServiceState {
            let output = Output {
                status: std::process::ExitStatus::default(),
                stdout: stdout.to_vec(),
                stderr: Vec::new(),
            };
            let value: Value = serde_json::from_slice(&output.stdout).unwrap();
            let service = value.get("service");
            match service
                .and_then(|service| service.get("loaded"))
                .and_then(Value::as_bool)
            {
                Some(false) => ServiceState::Absent,
                Some(true) => ServiceState::Installed {
                    running: service
                        .and_then(|service| service.get("runtime"))
                        .and_then(|runtime| runtime.get("status"))
                        .and_then(Value::as_str)
                        .and_then(|status| match status {
                            "running" => Some(true),
                            "stopped" => Some(false),
                            _ => None,
                        }),
                },
                None => ServiceState::Unverified,
            }
        };
        assert_eq!(
            read(br#"{"service":{"label":"openclaw-node","loaded":true,"runtime":{"status":"running"}}}"#),
            ServiceState::Installed { running: Some(true) }
        );
        assert_eq!(
            read(br#"{"service":{"label":"openclaw-node","loaded":true,"runtime":{"status":"stopped"}}}"#),
            ServiceState::Installed { running: Some(false) }
        );
        assert_eq!(
            read(br#"{"service":{"label":"openclaw-node","loaded":true,"runtime":{"status":"unknown","detail":"no manager"}}}"#),
            ServiceState::Installed { running: None }
        );
        assert_eq!(
            read(br#"{"service":{"label":"openclaw-node","loaded":false,"notLoadedText":"not installed"}}"#),
            ServiceState::Absent
        );
        assert_eq!(
            ServiceState::Installed { running: None }.installed(),
            None,
            "an unknown runtime state must not claim the service is absent"
        );
    }

    #[test]
    fn snapshots_serialize_run_clears_but_omit_preferences() {
        let running = Snapshot::from_run(
            1,
            &Run {
                phase: Phase::Running,
                mode: Some("service"),
                service: ServiceState::Installed {
                    running: Some(true),
                },
                paired: Some(true),
                detail: Some(String::from("installed")),
            },
            true,
        );
        let wire: Value = serde_json::from_str(&serde_json::to_string(&running).unwrap()).unwrap();
        assert_eq!(wire["mode"], "service");
        assert_eq!(wire["serviceInstalled"], serde_json::Value::Null);
        assert_eq!(wire["serviceRunning"], true);
        assert_eq!(wire["paired"], true);
        assert_eq!(wire["detail"], "installed");
        assert_eq!(wire["cliAvailable"], true);
        assert!(wire.get("consent").is_none());
        assert!(wire.get("displayName").is_none());

        let cleared = Snapshot::from_run(2, &Run::idle(ServiceState::Absent, Some(false)), false);
        let wire: Value = serde_json::from_str(&serde_json::to_string(&cleared).unwrap()).unwrap();
        assert_eq!(wire["mode"], serde_json::Value::Null);
        assert_eq!(wire["detail"], serde_json::Value::Null);
        assert_eq!(wire["serviceInstalled"], false);
        assert_eq!(wire["serviceRunning"], serde_json::Value::Null);
        assert_eq!(wire["paired"], false);
        assert_eq!(wire["cliAvailable"], false);
    }

    #[test]
    fn confirmed_absent_service_clears_the_unknown_detail() {
        assert_eq!(service_detail(true, &ServiceState::Absent), None);
        assert_eq!(
            service_detail(false, &ServiceState::Absent),
            Some(cli_missing_error())
        );
        assert_eq!(
            service_detail(
                true,
                &ServiceState::Installed {
                    running: Some(true)
                }
            )
            .as_deref(),
            Some("The background service is installed and running.")
        );
        assert_eq!(
            service_detail(
                true,
                &ServiceState::Installed {
                    running: Some(false)
                }
            )
            .as_deref(),
            Some("The service is stopped.")
        );
        assert_eq!(
            service_detail(true, &ServiceState::Installed { running: None }).as_deref(),
            Some("Service status is unknown.")
        );
        assert_eq!(
            service_detail(true, &ServiceState::Unverified).as_deref(),
            Some("Service status is unknown.")
        );
    }

    fn test_run(
        phase: Phase,
        mode: Option<&'static str>,
        service: ServiceState,
        paired: Option<bool>,
    ) -> Run {
        Run {
            phase,
            mode,
            service,
            paired,
            detail: None,
        }
    }

    #[test]
    fn pairing_probe_uses_the_cli_owned_resumable_fact() {
        assert_eq!(pairing_probe_arguments(), vec!["node", "pairing", "--json"]);
        assert_eq!(parse_pairing_probe(br#"{"resumable":true}"#).unwrap(), true);
        assert_eq!(
            parse_pairing_probe(br#"{"resumable":false}"#).unwrap(),
            false
        );
        assert!(parse_pairing_probe(br#"{"resumable":"yes"}"#).is_err());
        assert!(parse_pairing_probe(b"127.0.0.1").is_err());
    }

    #[test]
    fn stop_during_an_applying_service_action_targets_a_real_service_stop() {
        assert_eq!(
            Request::Service(ToolAction::Restart).active_kind(),
            ActiveRequest::Service
        );
        assert_eq!(
            Request::Foreground { pairing: None }.active_kind(),
            ActiveRequest::PairingChild
        );
        assert_eq!(Request::Idle.active_kind(), ActiveRequest::Idle);

        let applying = test_run(
            Phase::Preparing,
            Some("service"),
            ServiceState::Unverified,
            None,
        );
        assert_eq!(
            stop_target(&applying, ActiveRequest::Service, PairingStage::None),
            StopTarget::ServiceStop
        );
        // Once the supervised pairing child exists, cancelling and joining it
        // is the revocation.
        assert_eq!(
            stop_target(&applying, ActiveRequest::PairingChild, PairingStage::Child),
            StopTarget::CancelOwnedChild
        );

        // Before the replacement child exists, a pairing request is stopping
        // the old service; Stop must run that stop for real in both modes.
        for mode in ["foreground", "service"] {
            let re_pair_prep =
                test_run(Phase::Preparing, Some(mode), ServiceState::Unverified, None);
            assert_eq!(
                stop_target(
                    &re_pair_prep,
                    ActiveRequest::PairingChild,
                    PairingStage::Preparing
                ),
                StopTarget::ServiceStop,
                "{mode} re-pair preparation must stop the old service"
            );
            assert_eq!(
                stop_target(
                    &re_pair_prep,
                    ActiveRequest::PairingChild,
                    PairingStage::Child
                ),
                StopTarget::CancelOwnedChild,
                "{mode} replacement child must be cancelled"
            );
        }

        let running = test_run(
            Phase::Running,
            Some("service"),
            ServiceState::Installed {
                running: Some(true),
            },
            Some(true),
        );
        assert_eq!(
            stop_target(&running, ActiveRequest::Idle, PairingStage::None),
            StopTarget::ServiceStop
        );
        assert_eq!(
            stop_target(&running, ActiveRequest::Service, PairingStage::None),
            StopTarget::ServiceStop
        );

        let foreground_preparing = test_run(
            Phase::Preparing,
            Some("foreground"),
            ServiceState::Unverified,
            Some(true),
        );
        assert_eq!(
            stop_target(
                &foreground_preparing,
                ActiveRequest::PairingChild,
                PairingStage::Child
            ),
            StopTarget::CancelOwnedChild
        );
        let foreground_running = test_run(
            Phase::Running,
            Some("foreground"),
            ServiceState::Unverified,
            Some(true),
        );
        assert_eq!(
            stop_target(
                &foreground_running,
                ActiveRequest::PairingChild,
                PairingStage::Child
            ),
            StopTarget::CancelOwnedChild
        );

        let off = test_run(Phase::Off, None, ServiceState::Absent, Some(false));
        assert_eq!(
            stop_target(&off, ActiveRequest::Idle, PairingStage::None),
            StopTarget::Idle
        );
        let service_error = test_run(
            Phase::Error,
            Some("service"),
            ServiceState::Unverified,
            None,
        );
        assert_eq!(
            stop_target(&service_error, ActiveRequest::Service, PairingStage::None),
            StopTarget::ServiceStop
        );
    }

    #[cfg(unix)]
    #[test]
    fn stale_spawned_pairing_child_is_retained_until_joined() {
        use crate::desktop_node_process::{fail_next_stop_for_test, process_group_exists_for_test};
        use std::process::Command;

        // The request generation moved while the pairing child was spawning.
        let shared = Mutex::new(Shared {
            revision: 2,
            request: Request::Idle,
            pairing_stage: PairingStage::Preparing,
            stopping: false,
            status_revision: 0,
            status: test_run(Phase::Off, None, ServiceState::Absent, Some(true)),
            cli_available: true,
        });
        assert_eq!(
            note_spawned_pairing_child(&shared, 1),
            SpawnedChildGeneration::Stale
        );
        assert_eq!(
            shared.lock().expect("executor state").pairing_stage,
            PairingStage::Preparing
        );
        assert_eq!(
            note_spawned_pairing_child(&shared, 2),
            SpawnedChildGeneration::Current
        );
        assert_eq!(
            shared.lock().expect("executor state").pairing_stage,
            PairingStage::Child
        );

        // A real spawned child stands in for the stale pairing process.
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 120 & echo $!; wait"]);
        let process = DesktopNodeProcess::spawn(command).expect("fixture child");
        let pid = process.id_for_test();
        let mut child = Some(process);
        let mut probe_owner = None;
        let mut replacement_started = false;

        // A failed teardown must retain the exact owner and block replacement.
        fail_next_stop_for_test(pid, 1);
        if join_owned_processes(&mut child, &mut probe_owner).is_none() {
            replacement_started = true;
        }
        assert!(!replacement_started);
        assert_eq!(
            child.as_ref().map(DesktopNodeProcess::id_for_test),
            Some(pid)
        );
        assert!(process_group_exists_for_test(pid));

        // The retry joins the retained tree before a replacement may proceed.
        if join_owned_processes(&mut child, &mut probe_owner).is_none() {
            replacement_started = true;
        }
        assert!(replacement_started);
        assert!(child.is_none());
        assert!(probe_owner.is_none());
        assert!(!process_group_exists_for_test(pid));
    }

    #[test]
    fn service_authority_rules_route_without_falling_back_to_foreground() {
        let may_exist = |state: ServiceState| state.may_exist();
        assert!(may_exist(ServiceState::Unverified));
        assert!(may_exist(ServiceState::Installed {
            running: Some(false)
        }));
        assert!(!may_exist(ServiceState::Absent));
    }
}
