import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { BrowserProxyRequest } from "./browser-node-proxy.js";
import {
  browserHumanControlRequest,
  browserVaultObserve,
  browserVaultSubmit,
  callGatewayTool,
  jsonResult,
  type BrowserHumanControlRequestResult,
  type BrowserVaultObserveResult,
} from "./browser-tool.runtime.js";

const PREVIEW_TIMEOUT_MS = 15_000;
const APPROVAL_TIMEOUT_MS = 120_000;
const EXECUTE_TIMEOUT_MS = 15_000;
const TITLE_MAX_LENGTH = 80;
const DESCRIPTION_MAX_LENGTH = 500;

type VaultFillPreviewResponse = {
  status: string;
  itemRef?: string;
  siteLabel?: string;
  accountLabel?: string;
  origin: { scheme: "https" | "http"; host: string; port: number };
  previewId?: string;
  revision?: number;
  reasonCode?: string;
};

type VaultFillExecuteResponse = {
  status: string;
  itemRef?: string;
  siteLabel?: string;
  origin?: { scheme: "https" | "http"; host: string; port: number };
  reasonCode?: string;
};

type VaultFillApprovalResponse = {
  id: string;
  decision: "allow-once" | "allow-always" | "deny" | null;
};

export type VaultAutofillActionParams = {
  itemRef: string;
  reason?: string;
  submit?: boolean;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
  signal?: AbortSignal;
  agentId?: string;
  agentSessionKey?: string;
  onTabActivity?: (targetId: string) => void | Promise<void>;
};

function formatOrigin(origin: { scheme: string; host: string; port: number }): string {
  const defaultPort = origin.scheme === "https" ? 443 : 80;
  return origin.port === defaultPort
    ? `${origin.scheme}://${origin.host}`
    : `${origin.scheme}://${origin.host}:${String(origin.port)}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function publicStatus(status: {
  status: string;
  itemRef?: string;
  siteLabel?: string;
  origin?: { scheme: string; host: string; port: number };
  reasonCode?: string;
}): Record<string, unknown> {
  return {
    status: status.status,
    ...(status.itemRef ? { itemRef: status.itemRef } : {}),
    ...(status.siteLabel ? { siteLabel: status.siteLabel } : {}),
    ...(status.origin ? { origin: formatOrigin(status.origin) } : {}),
    ...(status.reasonCode ? { reasonCode: status.reasonCode } : {}),
  };
}

function needsHuman(reasonCode: string): AgentToolResult<unknown> {
  return jsonResult({ status: "needs_human", reasonCode });
}

/**
 * A login challenge is a human gate, not an agent retry loop. Ask the browser
 * owner to pause this tab; the Control UI claims the lease and hands it back
 * with a revalidated origin/document.
 */
async function requestHumanTakeover(
  params: VaultAutofillActionParams,
  reasonCode: string,
): Promise<AgentToolResult<unknown>> {
  let control: BrowserHumanControlRequestResult["control"] | undefined;
  try {
    const result = await browserHumanControlRequest(params.baseUrl, {
      targetId: params.targetId,
      reason: reasonCode,
      profile: params.profile,
      signal: params.signal,
      timeoutMs: PREVIEW_TIMEOUT_MS,
    });
    control = result.control;
  } catch {
    // The needs_human result still stands even when the panel cannot be notified.
  }
  return jsonResult({
    status: "needs_human",
    reasonCode,
    ...(control ? { control } : {}),
  });
}

function observeMatches(
  left: Extract<BrowserVaultObserveResult, { ok: true }>,
  right: Extract<BrowserVaultObserveResult, { ok: true }>,
): boolean {
  return (
    left.targetId === right.targetId &&
    left.origin.scheme === right.origin.scheme &&
    left.origin.host === right.origin.host &&
    left.origin.port === right.origin.port &&
    left.documentId === right.documentId &&
    left.frameId === right.frameId &&
    left.fieldSignature === right.fieldSignature
  );
}

function observeBinding(observation: Extract<BrowserVaultObserveResult, { ok: true }>) {
  return {
    origin: observation.origin,
    targetId: observation.targetId,
    documentId: observation.documentId,
    frameId: observation.frameId,
    fieldSignature: observation.fieldSignature,
  };
}

/**
 * Agent-facing fill path. The model only supplies an opaque itemRef; the origin
 * comes from the local browser observation. The password exists only in this
 * function's local scope between the internal execute response and the browser
 * control request, and it is never placed in the tool result.
 */
export async function executeVaultAutofillAction(
  params: VaultAutofillActionParams,
): Promise<AgentToolResult<unknown>> {
  if (params.proxyRequest) {
    return needsHuman("local_browser_required");
  }
  if (!params.profile) {
    return needsHuman("profile_required");
  }
  if (!params.agentId || !params.agentSessionKey) {
    return needsHuman("agent_identity_required");
  }
  let observed: Awaited<ReturnType<typeof browserVaultObserve>>;
  try {
    observed = await browserVaultObserve(params.baseUrl, {
      targetId: params.targetId ?? "",
      profile: params.profile,
      signal: params.signal,
      timeoutMs: PREVIEW_TIMEOUT_MS,
    });
  } catch {
    return jsonResult({ status: "needs_human", reasonCode: "browser_unavailable" });
  }
  if (!observed.ok) {
    if (observed.status === "needs_human") {
      return await requestHumanTakeover(params, observed.reasonCode ?? "agent_needs_human");
    }
    return jsonResult({
      status: observed.status,
      ...(observed.reasonCode ? { reasonCode: observed.reasonCode } : {}),
    });
  }

  let preview: VaultFillPreviewResponse;
  try {
    preview = await callGatewayTool<VaultFillPreviewResponse>(
      "vault.fill.preview",
      { timeoutMs: PREVIEW_TIMEOUT_MS },
      {
        itemRef: params.itemRef,
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
        ...observeBinding(observed),
        profile: params.profile,
      },
      {
        scopes: ["operator.vault"],
        requireAgentRuntimeIdentity: true,
        signal: params.signal,
      },
    );
  } catch {
    return jsonResult({ status: "unavailable", reasonCode: "preview_failed" });
  }
  if (preview.status !== "needs_approval" || !preview.previewId) {
    return jsonResult(publicStatus(preview));
  }

  const originText = formatOrigin(observed.origin);
  const reason =
    typeof params.reason === "string" && params.reason.trim().length > 0
      ? truncate(params.reason.trim(), 200)
      : "not provided";
  const detail = [
    "OpenClaw password vault fill",
    `preview: ${preview.previewId}`,
    `item: ${preview.itemRef ?? params.itemRef}`,
    `account: ${preview.accountLabel ?? "unknown"}`,
    `origin: ${originText}`,
    `profile: ${params.profile}`,
    `target: ${observed.targetId}`,
    `document: ${observed.documentId}`,
    `submit: ${params.submit === true ? "yes" : "no"}`,
  ].join("\n");

  let approval: VaultFillApprovalResponse;
  try {
    approval = await callGatewayTool<VaultFillApprovalResponse>(
      "vault.fill.approval.request",
      { timeoutMs: APPROVAL_TIMEOUT_MS + 15_000 },
      {
        title: truncate(`Password fill: ${preview.siteLabel ?? "saved login"}`, TITLE_MAX_LENGTH),
        description: truncate(
          `Agent ${params.agentId} wants to use a saved password on ${originText} (profile ${params.profile}). Reason: ${reason}`,
          DESCRIPTION_MAX_LENGTH,
        ),
        detail,
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        timeoutMs: APPROVAL_TIMEOUT_MS,
      },
      {
        scopes: ["operator.vault"],
        requireAgentRuntimeIdentity: true,
        signal: params.signal,
      },
    );
  } catch {
    return jsonResult({ status: "needs_approval", reasonCode: "approval_unavailable" });
  }
  if (approval.decision !== "allow-once") {
    return approval.decision === "deny"
      ? jsonResult({ status: "denied" })
      : jsonResult({ status: "needs_approval", reasonCode: "approval_timeout" });
  }

  let reobserved: Awaited<ReturnType<typeof browserVaultObserve>>;
  try {
    reobserved = await browserVaultObserve(params.baseUrl, {
      targetId: observed.targetId,
      profile: params.profile,
      signal: params.signal,
      timeoutMs: PREVIEW_TIMEOUT_MS,
    });
  } catch {
    return jsonResult({ status: "needs_human", reasonCode: "browser_unavailable" });
  }
  if (!reobserved.ok) {
    if (reobserved.status === "needs_human") {
      return await requestHumanTakeover(params, reobserved.reasonCode ?? "agent_needs_human");
    }
    return jsonResult({
      status: reobserved.status,
      ...(reobserved.reasonCode ? { reasonCode: reobserved.reasonCode } : {}),
    });
  }
  if (!observeMatches(observed, reobserved)) {
    return jsonResult({ status: "document_changed", reasonCode: "page_changed_after_approval" });
  }

  let executed: VaultFillExecuteResponse;
  try {
    executed = await callGatewayTool<VaultFillExecuteResponse>(
      "vault.fill.execute",
      { timeoutMs: EXECUTE_TIMEOUT_MS },
      {
        previewId: preview.previewId,
        approvalId: approval.id,
        itemRef: preview.itemRef ?? params.itemRef,
        revision: preview.revision,
        ...observeBinding(reobserved),
        profile: params.profile,
      },
      {
        scopes: ["operator.vault"],
        requireAgentRuntimeIdentity: true,
        signal: params.signal,
      },
    );
  } catch {
    return jsonResult({ status: "unavailable", reasonCode: "fill_execute_failed" });
  }
  if (executed.status !== "filled") {
    return jsonResult(publicStatus(executed));
  }
  await params.onTabActivity?.(reobserved.targetId);

  let submitted: boolean | undefined;
  let submitStatus: string | undefined;
  if (params.submit === true) {
    const decision = await requestSubmitApproval(params, originText);
    if (decision === "allow-once") {
      try {
        const submittedResult = await browserVaultSubmit(params.baseUrl, {
          targetId: reobserved.targetId,
          profile: params.profile,
          expected: observeBinding(reobserved),
          signal: params.signal,
          timeoutMs: EXECUTE_TIMEOUT_MS,
        });
        if (submittedResult.ok) {
          submitted = true;
        } else {
          submitted = false;
          submitStatus = submittedResult.reasonCode ?? submittedResult.status;
        }
      } catch {
        submitted = false;
        submitStatus = "unavailable";
      }
    } else {
      submitted = false;
      submitStatus = decision;
    }
  }

  return jsonResult({
    status: "filled",
    itemRef: executed.itemRef ?? preview.itemRef ?? params.itemRef,
    ...(executed.siteLabel ? { siteLabel: executed.siteLabel } : {}),
    origin: originText,
    submit: false,
    ...(submitted !== undefined ? { submitted } : {}),
    ...(submitStatus ? { submitStatus } : {}),
  });
}

async function requestSubmitApproval(
  params: VaultAutofillActionParams,
  originText: string,
): Promise<"allow-once" | "deny" | "needs_approval"> {
  try {
    const approval = await callGatewayTool<VaultFillApprovalResponse>(
      "vault.fill.approval.request",
      { timeoutMs: APPROVAL_TIMEOUT_MS + 15_000 },
      {
        title: truncate(`Submit login form: ${originText}`, TITLE_MAX_LENGTH),
        description: truncate(
          `Agent ${params.agentId} finished a password fill on ${originText} (profile ${params.profile}) and asks to submit the form.`,
          DESCRIPTION_MAX_LENGTH,
        ),
        detail: [
          "OpenClaw password vault submit",
          `origin: ${originText}`,
          `profile: ${params.profile ?? "unknown"}`,
          `target: ${params.targetId ?? "active"}`,
          "This is the separate submit authorization for the fill that just completed.",
        ].join("\n"),
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        timeoutMs: APPROVAL_TIMEOUT_MS,
      },
      {
        scopes: ["operator.vault"],
        requireAgentRuntimeIdentity: true,
        signal: params.signal,
      },
    );
    return approval.decision === "allow-once"
      ? "allow-once"
      : approval.decision === "deny"
        ? "deny"
        : "needs_approval";
  } catch {
    return "needs_approval";
  }
}
