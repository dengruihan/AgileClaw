//! Node occupancy lease state machine for embedding hosts.
//!
//! Exactly one session controls a device at a time and the node is the sole
//! authority. This module owns the lease decisions ([`NodeOccupancy`]), the
//! `occupancy.*` wire commands ([`occupancy_commands`]), and per-call admission
//! for leased commands ([`NodeOccupancy::admit`]). State is in-process: the
//! TypeScript node host additionally mirrors the holder identity into its
//! durable shared-state row and clears it on boot, while Rust hosts embed this
//! state machine without storage because process spawning and persistence stay
//! embedding-owned.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::runtime::{CommandRuntimeBuilder, HandlerError, InvocationContext};

pub const OCCUPANCY_ACQUIRE_COMMAND: &str = "occupancy.acquire.v1";
pub const OCCUPANCY_RENEW_COMMAND: &str = "occupancy.renew.v1";
pub const OCCUPANCY_RELEASE_COMMAND: &str = "occupancy.release.v1";
pub const OCCUPANCY_STATUS_COMMAND: &str = "occupancy.status.v1";
pub const OCCUPANCY_REVOKE_COMMAND: &str = "occupancy.revoke.v1";

/// The holder is the root session; the whole session tree shares one lease.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OccupancyAcquireParams {
    pub session_key: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub lease_token: String,
}

/// Lease-holder view of [`OccupancyLeaseTokenParams`] for borrow-only methods.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OccupancyLeaseTokenParams {
    pub session_key: String,
    pub lease_token: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OccupancyStatusParams {}

/// A session call names its holder identity and proves it with the lease token;
/// an operator call with neither force-clears the lease.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OccupancyRevokeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_token: Option<String>,
}

/// Holder identity as reported to callers; never includes the lease token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OccupancyHolder {
    pub session_key: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub acquired_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renewed_at_ms: Option<u64>,
    /// Host-launched background processes still holding the lease; part of the
    /// wire holder shape, so it is always serialized.
    #[serde(default)]
    pub detached_processes: u64,
}

/// Acquire/identity fields are bounded like the TypeScript node host.
const OCCUPANCY_IDENTITY_MAX_LEN: usize = 256;
const OCCUPANCY_LEASE_TOKEN_MAX_LEN: usize = 256;

fn validate_bounded(value: &str, field: &str, max_len: usize) -> Result<(), HandlerError> {
    if value.trim().is_empty() || value.len() > max_len || value.contains('\0') {
        return Err(HandlerError::new(
            "INVALID_REQUEST",
            format!("occupancy {field} must be a bounded non-empty string"),
        ));
    }
    Ok(())
}

fn validate_acquire(params: &OccupancyAcquireParams) -> Result<(), HandlerError> {
    validate_bounded(
        &params.session_key,
        "sessionKey",
        OCCUPANCY_IDENTITY_MAX_LEN,
    )?;
    validate_bounded(&params.session_id, "sessionId", OCCUPANCY_IDENTITY_MAX_LEN)?;
    validate_bounded(&params.run_id, "runId", OCCUPANCY_IDENTITY_MAX_LEN)?;
    validate_bounded(
        &params.lease_token,
        "leaseToken",
        OCCUPANCY_LEASE_TOKEN_MAX_LEN,
    )?;
    if let Some(agent_id) = params.agent_id.as_deref() {
        validate_bounded(agent_id, "agentId", OCCUPANCY_IDENTITY_MAX_LEN)?;
    }
    if let Some(turn_id) = params.turn_id.as_deref() {
        validate_bounded(turn_id, "turnId", OCCUPANCY_IDENTITY_MAX_LEN)?;
    }
    Ok(())
}

/// Extracts the `leaseToken` an execution command carries beside its own params.
fn lease_token_from_params(params: &Value) -> Option<&str> {
    params.get("leaseToken").and_then(Value::as_str)
}

fn require_bounded_token(value: &str) -> Result<(), HandlerError> {
    validate_bounded(value, "leaseToken", OCCUPANCY_LEASE_TOKEN_MAX_LEN)
}

struct OccupancyLease {
    holder: OccupancyHolder,
    lease_token: String,
}

/// Occupancy rejections surfaced to the Gateway as structured invoke errors.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OccupancyError {
    /// Another session holds the device; the holder identity travels with it.
    DeviceOccupied { holder: Box<OccupancyHolder> },
    /// The caller is the holder session but presented a stale or wrong token.
    LeaseTokenMismatch { session_key: String },
    /// No session holds the device.
    DeviceUnoccupied,
}

impl OccupancyError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::DeviceOccupied { .. } => "DEVICE_OCCUPIED",
            Self::LeaseTokenMismatch { .. } => "LEASE_TOKEN_MISMATCH",
            Self::DeviceUnoccupied => "DEVICE_UNOCCUPIED",
        }
    }

    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::DeviceOccupied { holder } => format!(
                "device occupied by session {}, session id {}{} since epoch-ms {}",
                holder.session_key,
                holder.session_id,
                holder
                    .agent_id
                    .as_deref()
                    .map(|agent| format!(", agent {agent}"))
                    .unwrap_or_default(),
                holder.acquired_at_ms
            ),
            Self::LeaseTokenMismatch { session_key } => format!(
                "lease token does not match the current lease for session {session_key}; the lease was likely re-acquired for a newer turn"
            ),
            Self::DeviceUnoccupied => {
                "device is not occupied; acquire the occupancy lease first".into()
            }
        }
    }

    fn into_handler_error(self) -> HandlerError {
        HandlerError::new(self.code(), self.message())
    }
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or_default())
        .unwrap_or_default()
}

/// Single-holder occupancy state machine shared across command handlers.
pub struct NodeOccupancy {
    lease: Mutex<Option<OccupancyLease>>,
}

impl Default for NodeOccupancy {
    fn default() -> Self {
        Self::new()
    }
}

impl NodeOccupancy {
    #[must_use]
    pub fn new() -> Self {
        Self {
            lease: Mutex::new(None),
        }
    }

    /// Acquire or re-acquire (new turn) the lease for one root session.
    ///
    /// # Errors
    ///
    /// Returns [`OccupancyError::DeviceOccupied`] when another session holds
    /// the device; the rejection carries the current holder identity.
    /// # Panics
    ///
    /// Panics if the occupancy lock is poisoned.
    pub fn acquire(
        &self,
        params: OccupancyAcquireParams,
    ) -> Result<OccupancyHolder, OccupancyError> {
        let mut lease = self.lease.lock().expect("occupancy lock poisoned");
        if let Some(current) = lease.as_ref() {
            if current.holder.session_key != params.session_key {
                return Err(OccupancyError::DeviceOccupied {
                    holder: Box::new(current.holder.clone()),
                });
            }
        }
        let acquired_at_ms = now_epoch_ms();
        let holder = OccupancyHolder {
            session_key: params.session_key,
            session_id: params.session_id,
            agent_id: params.agent_id,
            run_id: params.run_id,
            turn_id: params.turn_id,
            acquired_at_ms,
            renewed_at_ms: None,
            detached_processes: 0,
        };
        *lease = Some(OccupancyLease {
            holder: holder.clone(),
            lease_token: params.lease_token,
        });
        Ok(holder)
    }

    /// Refresh a held lease.
    ///
    /// # Errors
    ///
    /// Returns an error when the device is unoccupied, held by another
    /// session, or the token does not match the current lease.
    /// # Panics
    ///
    /// Panics if the occupancy lock is poisoned.
    pub fn renew(
        &self,
        params: &OccupancyLeaseTokenParams,
    ) -> Result<OccupancyHolder, OccupancyError> {
        let mut lease = self.lease.lock().expect("occupancy lock poisoned");
        let current = lease.as_mut().ok_or(OccupancyError::DeviceUnoccupied)?;
        if current.holder.session_key != params.session_key {
            return Err(OccupancyError::DeviceOccupied {
                holder: Box::new(current.holder.clone()),
            });
        }
        if current.lease_token != params.lease_token {
            return Err(OccupancyError::LeaseTokenMismatch {
                session_key: current.holder.session_key.clone(),
            });
        }
        current.holder.renewed_at_ms = Some(now_epoch_ms());
        Ok(current.holder.clone())
    }

    /// Release a held lease; releasing an unoccupied device is idempotent.
    ///
    /// # Errors
    ///
    /// Returns an error when another session holds the device or the token
    /// does not match the current lease.
    /// # Panics
    ///
    /// Panics if the occupancy lock is poisoned.
    pub fn release(&self, params: &OccupancyLeaseTokenParams) -> Result<bool, OccupancyError> {
        let mut lease = self.lease.lock().expect("occupancy lock poisoned");
        let Some(current) = lease.as_ref() else {
            return Ok(false);
        };
        if current.holder.session_key != params.session_key {
            return Err(OccupancyError::DeviceOccupied {
                holder: Box::new(current.holder.clone()),
            });
        }
        if current.lease_token != params.lease_token {
            return Err(OccupancyError::LeaseTokenMismatch {
                session_key: current.holder.session_key.clone(),
            });
        }
        *lease = None;
        Ok(true)
    }

    /// Current occupancy; the holder identity excludes the lease token.
    /// # Panics
    ///
    /// Panics if the occupancy lock is poisoned.
    #[must_use]
    pub fn status(&self) -> Value {
        let lease = self.lease.lock().expect("occupancy lock poisoned");
        match lease.as_ref() {
            Some(current) => json!({"occupied": true, "holder": current.holder}),
            None => json!({"occupied": false}),
        }
    }

    /// Force-clear occupancy; embedding hosts tree-kill holder-owned processes
    /// before calling this. Naming a session requires the current lease token,
    /// exactly like the TypeScript node host; passing neither is the operator
    /// force-clear path.
    ///
    /// # Errors
    ///
    /// Returns [`OccupancyError::DeviceOccupied`] when a different session was
    /// named, and [`OccupancyError::LeaseTokenMismatch`] when a named session did
    /// not present the current token.
    /// # Panics
    ///
    /// Panics if the occupancy lock is poisoned.
    pub fn revoke(
        &self,
        session_key: Option<&str>,
        lease_token: Option<&str>,
    ) -> Result<Option<OccupancyHolder>, OccupancyError> {
        let mut lease = self.lease.lock().expect("occupancy lock poisoned");
        let Some(current) = lease.as_ref() else {
            return Ok(None);
        };
        if let Some(requested) = session_key {
            if current.holder.session_key != requested {
                return Err(OccupancyError::DeviceOccupied {
                    holder: Box::new(current.holder.clone()),
                });
            }
            if lease_token != Some(current.lease_token.as_str()) {
                return Err(OccupancyError::LeaseTokenMismatch {
                    session_key: current.holder.session_key.clone(),
                });
            }
        }
        Ok(lease.take().map(|cleared| cleared.holder))
    }

    /// Per-call admission: the caller must be the holder session presenting
    /// the current lease token.
    ///
    /// # Errors
    ///
    /// Returns an error describing why the command must not run.
    /// # Panics
    ///
    /// Panics if the occupancy lock is poisoned.
    pub fn admit(
        &self,
        session_key: Option<&str>,
        lease_token: Option<&str>,
    ) -> Result<(), OccupancyError> {
        let lease = self.lease.lock().expect("occupancy lock poisoned");
        let Some(current) = lease.as_ref() else {
            return Err(OccupancyError::DeviceUnoccupied);
        };
        if session_key != Some(current.holder.session_key.as_str()) {
            return Err(OccupancyError::DeviceOccupied {
                holder: Box::new(current.holder.clone()),
            });
        }
        if lease_token != Some(current.lease_token.as_str()) {
            return Err(OccupancyError::LeaseTokenMismatch {
                session_key: current.holder.session_key.clone(),
            });
        }
        Ok(())
    }

    /// Admission helper for embedding hosts: pass the invoke's session key and
    /// the command's decoded params. The `leaseToken` rides inside the params,
    /// so no extra wire field is needed for non-occupancy commands.
    ///
    /// # Errors
    ///
    /// Returns the same rejections as [`NodeOccupancy::admit`].
    /// # Panics
    ///
    /// Panics if the occupancy lock is poisoned.
    pub fn admit_invocation(
        &self,
        session_key: Option<&str>,
        params: &Value,
    ) -> Result<(), OccupancyError> {
        self.admit(session_key, lease_token_from_params(params))
    }

    fn handle_request(&self, command: &str, params: &Value) -> Result<Value, HandlerError> {
        match command {
            OCCUPANCY_ACQUIRE_COMMAND => {
                let params = parse_params::<OccupancyAcquireParams>(params)?;
                validate_acquire(&params)?;
                let holder = self
                    .acquire(params)
                    .map_err(OccupancyError::into_handler_error)?;
                Ok(json!({"ok": true, "holder": holder}))
            }
            OCCUPANCY_RENEW_COMMAND => {
                let params = parse_params::<OccupancyLeaseTokenParams>(params)?;
                validate_bounded(
                    &params.session_key,
                    "sessionKey",
                    OCCUPANCY_IDENTITY_MAX_LEN,
                )?;
                require_bounded_token(&params.lease_token)?;
                let holder = self
                    .renew(&params)
                    .map_err(OccupancyError::into_handler_error)?;
                Ok(json!({"ok": true, "holder": holder}))
            }
            OCCUPANCY_RELEASE_COMMAND => {
                let params = parse_params::<OccupancyLeaseTokenParams>(params)?;
                validate_bounded(
                    &params.session_key,
                    "sessionKey",
                    OCCUPANCY_IDENTITY_MAX_LEN,
                )?;
                require_bounded_token(&params.lease_token)?;
                let released = self
                    .release(&params)
                    .map_err(OccupancyError::into_handler_error)?;
                Ok(json!({"ok": true, "released": released}))
            }
            OCCUPANCY_STATUS_COMMAND => Ok(self.status()),
            OCCUPANCY_REVOKE_COMMAND => {
                let params = parse_params::<OccupancyRevokeParams>(params)?;
                if let Some(session_key) = params.session_key.as_deref() {
                    validate_bounded(session_key, "sessionKey", OCCUPANCY_IDENTITY_MAX_LEN)?;
                    let token = params.lease_token.as_deref().ok_or_else(|| {
                        HandlerError::new(
                            "LEASE_TOKEN_MISMATCH",
                            "lease token does not match the current lease; a session revoke requires the current token".to_string(),
                        )
                    })?;
                    require_bounded_token(token)?;
                }
                let holder = self
                    .revoke(params.session_key.as_deref(), params.lease_token.as_deref())
                    .map_err(OccupancyError::into_handler_error)?;
                Ok(json!({"ok": true, "revoked": holder.is_some(), "holder": holder}))
            }
            other => Err(HandlerError::new(
                "UNAVAILABLE",
                format!("unknown occupancy command {other}"),
            )),
        }
    }
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: &Value) -> Result<T, HandlerError> {
    serde_json::from_value(params.clone()).map_err(|error| {
        HandlerError::new(
            "INVALID_REQUEST",
            format!("occupancy params invalid: {error}"),
        )
    })
}

/// Register the five occupancy lifecycle commands on a runtime builder.
///
/// Embedding contract: these handlers own the lease decisions only. The host
/// still owns process spawning, process-tree cleanup on revoke/disconnect, boot
/// clearing, and per-call admission for every other command — call
/// [`NodeOccupancy::admit_invocation`] before dispatching anything that is not
/// an occupancy lifecycle command or operator approval policy. Only the
/// TypeScript node host currently ships a process registry and durable boot
/// clearing; a Rust host that executes tools must supply both or advertise no
/// execution commands.
#[must_use]
pub fn occupancy_commands(
    builder: CommandRuntimeBuilder,
    occupancy: &std::sync::Arc<NodeOccupancy>,
) -> CommandRuntimeBuilder {
    let commands = [
        OCCUPANCY_ACQUIRE_COMMAND,
        OCCUPANCY_RENEW_COMMAND,
        OCCUPANCY_RELEASE_COMMAND,
        OCCUPANCY_STATUS_COMMAND,
        OCCUPANCY_REVOKE_COMMAND,
    ];
    commands.into_iter().fold(builder, |builder, command| {
        let occupancy = std::sync::Arc::clone(occupancy);
        builder.command(command, move |context: InvocationContext| {
            let occupancy = std::sync::Arc::clone(&occupancy);
            async move {
                occupancy.handle_request(
                    context.invocation.command.as_str(),
                    &context.invocation.params,
                )
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acquire_params(session_key: &str, lease_token: &str) -> OccupancyAcquireParams {
        OccupancyAcquireParams {
            session_key: session_key.into(),
            session_id: "session-1".into(),
            agent_id: None,
            run_id: "run-1".into(),
            turn_id: Some("turn-1".into()),
            lease_token: lease_token.into(),
        }
    }

    fn token_params(session_key: &str, lease_token: &str) -> OccupancyLeaseTokenParams {
        OccupancyLeaseTokenParams {
            session_key: session_key.into(),
            lease_token: lease_token.into(),
        }
    }

    #[test]
    fn acquire_admits_same_session_reacquire_and_rejects_other_sessions() {
        let occupancy = NodeOccupancy::new();
        let first = occupancy
            .acquire(acquire_params("agent:root:1", "token-1"))
            .unwrap();
        assert_eq!(first.session_key, "agent:root:1");
        // A new turn for the same root session replaces the lease.
        occupancy
            .acquire(acquire_params("agent:root:1", "token-2"))
            .unwrap();
        let rejection = occupancy
            .acquire(acquire_params("agent:root:2", "token-3"))
            .unwrap_err();
        let OccupancyError::DeviceOccupied { ref holder } = rejection else {
            panic!("expected DeviceOccupied");
        };
        assert_eq!(holder.session_key, "agent:root:1");
        assert_eq!(rejection.code(), "DEVICE_OCCUPIED");
        assert!(rejection.message().contains("agent:root:1"));
    }

    #[test]
    fn renew_validates_session_and_token_explicitly() {
        let occupancy = NodeOccupancy::new();
        occupancy
            .acquire(acquire_params("agent:root:1", "token-1"))
            .unwrap();
        assert!(occupancy
            .renew(&token_params("agent:root:1", "token-1"))
            .is_ok());
        assert_eq!(
            occupancy
                .renew(&token_params("agent:root:1", "stale"))
                .unwrap_err(),
            OccupancyError::LeaseTokenMismatch {
                session_key: "agent:root:1".into()
            }
        );
        assert_eq!(
            occupancy
                .renew(&token_params("agent:root:2", "token-1"))
                .unwrap_err()
                .code(),
            "DEVICE_OCCUPIED"
        );
        occupancy
            .release(&token_params("agent:root:1", "token-1"))
            .unwrap();
        assert_eq!(
            occupancy
                .renew(&token_params("agent:root:1", "token-1"))
                .unwrap_err(),
            OccupancyError::DeviceUnoccupied
        );
    }

    #[test]
    fn release_is_idempotent_and_revoke_force_clears() {
        let occupancy = NodeOccupancy::new();
        assert!(!occupancy
            .release(&token_params("agent:root:1", "token-1"))
            .unwrap());
        occupancy
            .acquire(acquire_params("agent:root:1", "token-1"))
            .unwrap();
        assert!(occupancy
            .release(&token_params("agent:root:1", "token-1"))
            .unwrap());
        assert!(!occupancy.status()["occupied"].as_bool().unwrap());

        occupancy
            .acquire(acquire_params("agent:root:1", "token-1"))
            .unwrap();
        assert_eq!(
            occupancy
                .revoke(Some("agent:root:2"), Some("token-1"))
                .unwrap_err()
                .code(),
            "DEVICE_OCCUPIED"
        );
        // A named session must prove the current token, like the TypeScript host.
        assert_eq!(
            occupancy
                .revoke(Some("agent:root:1"), Some("stale"))
                .unwrap_err()
                .code(),
            "LEASE_TOKEN_MISMATCH"
        );
        assert_eq!(
            occupancy
                .revoke(Some("agent:root:1"), None)
                .unwrap_err()
                .code(),
            "LEASE_TOKEN_MISMATCH"
        );
        let cleared = occupancy
            .revoke(Some("agent:root:1"), Some("token-1"))
            .unwrap();
        assert_eq!(cleared.unwrap().session_key, "agent:root:1");
        assert!(!occupancy.status()["occupied"].as_bool().unwrap());
    }

    #[test]
    fn holder_serializes_the_detached_process_count() {
        let occupancy = NodeOccupancy::new();
        occupancy
            .acquire(acquire_params("agent:root:1", "token-1"))
            .unwrap();
        assert_eq!(occupancy.status()["holder"]["detachedProcesses"], 0);
    }

    #[test]
    fn admission_helper_reads_the_lease_token_from_command_params() {
        let occupancy = NodeOccupancy::new();
        occupancy
            .acquire(acquire_params("agent:root:1", "token-1"))
            .unwrap();
        let params = json!({"leaseToken": "token-1", "command": ["true"]});
        assert!(occupancy
            .admit_invocation(Some("agent:root:1"), &params)
            .is_ok());
        assert_eq!(
            occupancy
                .admit_invocation(Some("agent:root:1"), &json!({}))
                .unwrap_err()
                .code(),
            "LEASE_TOKEN_MISMATCH"
        );
        assert_eq!(
            occupancy
                .admit_invocation(Some("agent:root:2"), &params)
                .unwrap_err()
                .code(),
            "DEVICE_OCCUPIED"
        );
    }

    #[test]
    fn acquire_rejects_empty_or_unbounded_identity() {
        let occupancy = NodeOccupancy::new();
        let mut params = acquire_params("agent:root:1", "token-1");
        params.session_key = "  ".into();
        let error = occupancy
            .handle_request(
                OCCUPANCY_ACQUIRE_COMMAND,
                &serde_json::to_value(params).unwrap(),
            )
            .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");

        let mut params = acquire_params("agent:root:1", "token-1");
        params.lease_token = "t".repeat(OCCUPANCY_LEASE_TOKEN_MAX_LEN + 1);
        let error = occupancy
            .handle_request(
                OCCUPANCY_ACQUIRE_COMMAND,
                &serde_json::to_value(params).unwrap(),
            )
            .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");
    }

    #[test]
    fn revoke_command_requires_a_token_when_a_session_is_named() {
        let occupancy = NodeOccupancy::new();
        occupancy
            .acquire(acquire_params("agent:root:1", "token-1"))
            .unwrap();
        let error = occupancy
            .handle_request(
                OCCUPANCY_REVOKE_COMMAND,
                &json!({"sessionKey": "agent:root:1"}),
            )
            .unwrap_err();
        assert_eq!(error.code, "LEASE_TOKEN_MISMATCH");
        let revoked = occupancy
            .handle_request(
                OCCUPANCY_REVOKE_COMMAND,
                &json!({"sessionKey": "agent:root:1", "leaseToken": "token-1"}),
            )
            .unwrap();
        assert_eq!(revoked["revoked"], true);
    }

    #[test]
    fn admit_requires_holder_session_and_current_token() {
        let occupancy = NodeOccupancy::new();
        assert_eq!(
            occupancy
                .admit(Some("agent:root:1"), Some("token-1"))
                .unwrap_err(),
            OccupancyError::DeviceUnoccupied
        );
        occupancy
            .acquire(acquire_params("agent:root:1", "token-1"))
            .unwrap();
        assert!(occupancy
            .admit(Some("agent:root:1"), Some("token-1"))
            .is_ok());
        assert_eq!(
            occupancy
                .admit(Some("agent:root:2"), Some("token-1"))
                .unwrap_err()
                .code(),
            "DEVICE_OCCUPIED"
        );
        assert_eq!(
            occupancy
                .admit(Some("agent:root:1"), None)
                .unwrap_err()
                .code(),
            "LEASE_TOKEN_MISMATCH"
        );
        assert_eq!(
            occupancy.admit(None, Some("token-1")).unwrap_err().code(),
            "DEVICE_OCCUPIED"
        );
    }

    #[test]
    fn status_and_command_json_never_expose_the_lease_token() {
        let occupancy = NodeOccupancy::new();
        occupancy
            .acquire(acquire_params("agent:root:1", "secret-token"))
            .unwrap();
        let status = occupancy.status().to_string();
        assert!(!status.contains("secret-token"));
        let result = occupancy
            .handle_request(OCCUPANCY_STATUS_COMMAND, &json!({}))
            .unwrap();
        assert!(!result.to_string().contains("secret-token"));
    }

    #[test]
    fn occupancy_commands_register_on_the_runtime_builder() {
        let occupancy = std::sync::Arc::new(NodeOccupancy::new());
        let runtime = occupancy_commands(crate::runtime::CommandRuntime::builder(), &occupancy)
            .build()
            .unwrap();
        let mut registered: Vec<&str> = runtime.command_names().collect();
        registered.sort_unstable();
        assert_eq!(
            registered,
            vec![
                OCCUPANCY_ACQUIRE_COMMAND,
                OCCUPANCY_RELEASE_COMMAND,
                OCCUPANCY_RENEW_COMMAND,
                OCCUPANCY_REVOKE_COMMAND,
                OCCUPANCY_STATUS_COMMAND
            ]
        );
        let result = occupancy
            .handle_request(
                OCCUPANCY_ACQUIRE_COMMAND,
                &serde_json::to_value(acquire_params("agent:root:1", "token-1")).unwrap(),
            )
            .unwrap();
        assert_eq!(result["holder"]["sessionKey"], "agent:root:1");
        assert_eq!(occupancy.status()["holder"]["sessionId"], "session-1");
        let rejection = occupancy
            .handle_request(
                OCCUPANCY_ACQUIRE_COMMAND,
                &serde_json::to_value(acquire_params("agent:root:2", "token-2")).unwrap(),
            )
            .unwrap_err();
        assert_eq!(rejection.code, "DEVICE_OCCUPIED");
        assert!(rejection.message.contains("agent:root:1"));
    }

    #[test]
    fn occupancy_params_reject_unknown_shapes() {
        let occupancy = NodeOccupancy::new();
        let error = occupancy
            .handle_request(
                OCCUPANCY_ACQUIRE_COMMAND,
                &json!({"sessionKey": "agent:root:1"}),
            )
            .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");
    }
}
