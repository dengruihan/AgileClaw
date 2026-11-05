/** Device occupancy lease facts for the generic execution decision owner. */
import { createHash } from "node:crypto";
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import { DEVICE_LEASE_RECEIPT_ID_PREFIX } from "./device-lease-receipt-id.js";
import { recordExecutionDecisionWork } from "./execution-decision-work.js";
import type { ExecutionIdentityAdmissionToken } from "./execution-identity-admission.js";

export type DeviceLeaseRejectReason = "occupied" | "disabled" | "disconnected" | "not-executor";

export type DeviceLeaseReleaseReason = "released" | "revoked" | "turn-end" | "stop" | "delete";

export type DeviceLeaseDecisionPhase = "acquire" | "release" | "reject";

const DEVICE_LEASE_DECISION_BOUNDARY = "session-device-scope.lease";
const DEVICE_REF_MAX_LENGTH = 4_096;
const SESSION_REF_MAX_LENGTH = 4_096;

const PERMISSION_MODES = new Set(["read-only", "guarded", "workspace", "full"]);

function receiptId(params: {
  contextId: string;
  operation: string;
  reasonCode: string;
  deviceId: string;
  discriminator: string | null;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        params.contextId,
        params.operation,
        params.reasonCode,
        params.deviceId,
        params.discriminator,
      ]),
    )
    .digest("base64url")
    .slice(0, 32);
  // Transport identity only: the decision writer re-keys this digest with the
  // installation audit HMAC before the fact persists.
  return `${DEVICE_LEASE_RECEIPT_ID_PREFIX}${digest}`;
}

const REJECT_SUMMARIES: Record<DeviceLeaseRejectReason, string> = {
  occupied: "The device node refused the occupancy lease because another holder occupies it.",
  disabled: "The paired device is disabled, so its occupancy lease was rejected.",
  disconnected: "The paired device is not connected, so its occupancy lease was rejected.",
  "not-executor": "The paired device lacks the device executor surface, so its lease was rejected.",
};

const REJECT_REMEDIATIONS: Record<DeviceLeaseRejectReason, DecisionReceiptV1["remediation"]> = {
  occupied: [
    {
      code: "device_occupied",
      text: "Retry after the holder releases the device, or switch the session to gateway scope.",
    },
  ],
  disabled: [
    {
      code: "device_disabled",
      text: "Enable the device with node.device.enable before routing a session to it.",
    },
  ],
  disconnected: [
    {
      code: "device_disconnected",
      text: "Start the node host on that device and retry; there is no gateway fallback.",
    },
  ],
  "not-executor": [
    {
      code: "device_not_executor",
      text: "Run the node host with the executor profile on that device and retry.",
    },
  ],
};

const RELEASE_SUMMARIES: Record<DeviceLeaseReleaseReason, string> = {
  released:
    "The device occupancy lease was released for a scope change, session retirement, or node-reported release.",
  revoked: "The device occupancy lease was force-revoked while the device was disabled.",
  "turn-end": "The turn that used the device occupancy lease ended and handed it back.",
  stop: "A session stop released the device occupancy lease the session tree held.",
  delete: "The device pairing was removed, retiring its mirrored occupancy leases.",
};

function boundedRef(value: string | undefined, max: number): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length <= max ? normalized : undefined;
}

/**
 * Queue one device lease transition fact. Raw device, session, and lease-token
 * bytes never reach persistence: the writer HMAC-projects the refs and replaces
 * the receipt id's transport digest with the keyed audit projection. Without an
 * admitted execution token the owner records nothing.
 */
export function recordDeviceLeaseDecision(params: {
  token: ExecutionIdentityAdmissionToken | undefined;
  phase: DeviceLeaseDecisionPhase;
  deviceId: string;
  rootSessionKey: string;
  agentId?: string;
  permissionMode?: string;
  rejectReason?: DeviceLeaseRejectReason;
  releaseReason?: DeviceLeaseReleaseReason;
  /** Opaque node lease token; hashed into the receipt id and never retained. */
  leaseToken?: string;
  occurredAt?: number;
}): boolean {
  const token = params.token;
  const deviceId = boundedRef(params.deviceId, DEVICE_REF_MAX_LENGTH);
  const rootSessionKey = boundedRef(params.rootSessionKey, SESSION_REF_MAX_LENGTH);
  if (!token || !deviceId || !rootSessionKey) {
    return false;
  }
  const operation = `device.lease.${params.phase}`;
  const reasonCode =
    params.phase === "acquire"
      ? "device_lease_acquired"
      : params.phase === "reject"
        ? `device_lease_rejected_${params.rejectReason?.replaceAll("-", "_") ?? "unknown"}`
        : `device_lease_${params.releaseReason?.replaceAll("-", "_") ?? "released"}`;
  if (params.phase === "reject" && !params.rejectReason) {
    return false;
  }
  if (params.phase === "release" && !params.releaseReason) {
    return false;
  }
  const permissionMode = params.permissionMode?.trim();
  const id = receiptId({
    contextId: token.contextId,
    operation,
    reasonCode,
    deviceId,
    discriminator: boundedRef(params.leaseToken, DEVICE_REF_MAX_LENGTH) ?? null,
  });
  const summary =
    params.phase === "acquire"
      ? "The device node granted the occupancy lease for a device-scoped session turn."
      : params.phase === "reject"
        ? (REJECT_SUMMARIES[params.rejectReason ?? "occupied"] ?? REJECT_SUMMARIES.occupied)
        : (RELEASE_SUMMARIES[params.releaseReason ?? "released"] ?? RELEASE_SUMMARIES.released);
  return recordExecutionDecisionWork({
    workVersion: 1,
    token,
    receipt: {
      schemaVersion: 1,
      receiptId: id,
      occurredAt: params.occurredAt ?? Date.now(),
      action: {
        family: "device",
        operation,
        summary,
      },
      decision: {
        outcome:
          params.phase === "acquire"
            ? "allowed"
            : params.phase === "reject"
              ? "denied"
              : "not-applicable",
        reasonCode,
      },
      enforcement: {
        coverageState: params.phase === "release" ? "attribution-only" : "enforced",
        policyRefs:
          permissionMode && PERMISSION_MODES.has(permissionMode)
            ? [`session-permission-mode:${permissionMode}`]
            : [],
        grantRefs: [],
        contextFieldsUsed: ["contextId", "executionId", "runId"],
      },
      source: {
        owner: "device-scope",
        recordRef: id,
        decisionBoundary: DEVICE_LEASE_DECISION_BOUNDARY,
      },
      missingEvidence: [],
      remediation:
        params.phase === "reject" ? REJECT_REMEDIATIONS[params.rejectReason ?? "occupied"] : [],
    },
    refs: {
      resource: { namespace: "device", value: deviceId },
      target: {
        namespace: "session",
        value: JSON.stringify([params.agentId?.trim() ?? null, rootSessionKey]),
      },
    },
  });
}
