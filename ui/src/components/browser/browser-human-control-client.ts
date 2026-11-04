/**
 * Human-control panel client.
 *
 * Kept separate from the general browser client so lease handling (and the
 * capability token) has one owner and the panel client stays under its size
 * budget. This module never stores the token beyond the controller that owns
 * the tab.
 */
import type { GatewayClientRequestOptions } from "@openclaw/gateway-client";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import type { BrowserRequestClient } from "./browser-client.ts";

type BrowserRequestEnvelope = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
};

/** Tab ownership reported by the browser control service. */
export type BrowserHumanControl = {
  owner: "human";
  status: "requested" | "active";
  reason: string;
  requestedBy: "agent" | "human";
  profile: string;
  targetId: string;
  tabId?: string;
  generation: number;
  claimedAtMs: number;
  expiresAtMs: number;
};

export type BrowserHumanControlState = {
  supported: boolean;
  control: BrowserHumanControl | null;
};

function browserRequest<T>(
  client: BrowserRequestClient,
  envelope: BrowserRequestEnvelope,
  options?: GatewayClientRequestOptions,
): Promise<T> {
  return options
    ? client.request<T>("browser.request", envelope, options)
    : client.request<T>("browser.request", envelope);
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function normalizeHumanControl(value: unknown): BrowserHumanControl | null {
  const record = asRecord(value);
  if (
    record?.owner !== "human" ||
    (record.status !== "requested" && record.status !== "active") ||
    (record.requestedBy !== "agent" && record.requestedBy !== "human") ||
    typeof record.profile !== "string" ||
    typeof record.targetId !== "string" ||
    typeof record.reason !== "string" ||
    typeof record.generation !== "number" ||
    typeof record.claimedAtMs !== "number" ||
    typeof record.expiresAtMs !== "number"
  ) {
    return null;
  }
  return {
    owner: "human",
    status: record.status,
    reason: record.reason,
    requestedBy: record.requestedBy,
    profile: record.profile,
    targetId: record.targetId,
    ...(typeof record.tabId === "string" && record.tabId ? { tabId: record.tabId } : {}),
    generation: record.generation,
    claimedAtMs: record.claimedAtMs,
    expiresAtMs: record.expiresAtMs,
  };
}

export async function readBrowserHumanControl(
  client: BrowserRequestClient,
  params: { targetId?: string },
): Promise<BrowserHumanControlState> {
  const result = asRecord(
    await browserRequest(client, {
      method: "GET",
      path: "/human-control",
      ...(params.targetId ? { query: { targetId: params.targetId } } : {}),
    }),
  );
  return {
    supported: result?.supported === true,
    control: normalizeHumanControl(result?.control),
  };
}

/** Claim human control and receive the one-time interaction capability. */
export async function claimBrowserHumanControl(
  client: BrowserRequestClient,
  params: { targetId: string; reason?: string },
): Promise<{ control: BrowserHumanControl; token: string }> {
  const result = asRecord(
    await browserRequest(client, {
      method: "POST",
      path: "/human-control/claim",
      body: { targetId: params.targetId, reason: params.reason ?? "user_request" },
    }),
  );
  const control = normalizeHumanControl(result?.control);
  const token = stringOrEmpty(result?.humanControlToken);
  if (!control || !token) {
    throw new Error(t("browser.errors.humanControlClaimFailed"));
  }
  return { control, token };
}

export async function releaseBrowserHumanControl(
  client: BrowserRequestClient,
  params: { targetId: string; humanControlToken: string },
): Promise<void> {
  await browserRequest(client, {
    method: "POST",
    path: "/human-control/release",
    body: params,
  });
}

export async function cancelBrowserHumanControl(
  client: BrowserRequestClient,
  params: { targetId: string; humanControlToken: string },
): Promise<void> {
  await browserRequest(client, {
    method: "POST",
    path: "/human-control/cancel",
    body: params,
  });
}

/**
 * Human-only sensitive input. The value travels to the browser owner and is
 * masked in results; it never enters a model request, tool result, or log line.
 */
export async function sendSensitiveBrowserInput(
  client: BrowserRequestClient,
  params: { targetId: string; text: string; humanControlToken: string },
): Promise<{ ok: boolean; reasonCode?: string }> {
  try {
    const result = asRecord(
      await browserRequest(client, {
        method: "POST",
        path: "/human-input",
        body: params,
      }),
    );
    return {
      ok: result?.ok === true,
      ...(typeof result?.reasonCode === "string" ? { reasonCode: result.reasonCode } : {}),
    };
  } catch {
    // Transport errors can echo request bodies containing the sensitive value.
    throw new Error(t("browser.errors.sensitiveInputFailed"));
  }
}
