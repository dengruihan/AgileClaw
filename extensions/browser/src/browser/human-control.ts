/**
 * Tab-scoped human control leases.
 *
 * A lease pauses agent interaction with one browser tab while a human drives a
 * login challenge (CAPTCHA, 2FA, consent, manual field entry). The lease is a
 * capability: the Control UI that claims it receives a one-time token, and only
 * requests carrying that token may act on the tab while the human owns it. The
 * agent tool surface never sees the token, so an agent run triggered from the
 * same Gateway connection still cannot act through the lease.
 *
 * Leases are process-local, bounded, and keyed by the stable per-profile tab
 * alias when the browser runtime provides one. They never carry page content,
 * passwords, OTP values, or TOTP seeds.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const HUMAN_CONTROL_REQUEST_TTL_MS = 2 * 60_000;
export const HUMAN_CONTROL_ACTIVE_TTL_MS = 5 * 60_000;
export const HUMAN_CONTROL_MAX_DURATION_MS = 30 * 60_000;
const MAX_LEASES = 256;
const MAX_REASON_LENGTH = 64;

export type HumanControlRequestedBy = "agent" | "human";
export type HumanControlStatus = "requested" | "active";
export type HumanControlOrigin = { scheme: string; host: string; port: number };

/** Public lease facts. Never includes the capability token or page values. */
export type HumanControlSnapshot = {
  owner: "human";
  status: HumanControlStatus;
  reason: string;
  requestedBy: HumanControlRequestedBy;
  profile: string;
  targetId: string;
  /** Stable per-profile tab alias when the runtime assigned one. */
  tabId?: string;
  generation: number;
  claimedAtMs: number;
  expiresAtMs: number;
};

export type HumanControlClaimResult = {
  control: HumanControlSnapshot;
  /** Returned once to the claiming Control UI; never included in status reads. */
  token: string;
};

export type HumanControlHandback = {
  url: string;
  origin: HumanControlOrigin;
  documentId: string;
  originChanged: boolean;
  loginStateChanged: boolean;
  revalidated: true;
};

type HumanControlRecord = {
  key: string;
  control: HumanControlSnapshot;
  tokenHash: Buffer;
  connId?: string;
  origin?: HumanControlOrigin;
  documentId?: string;
  cookieFingerprint?: string;
  absoluteExpiresAtMs: number;
};

export type HumanControlClaimInput = {
  profile: string;
  targetId: string;
  tabId?: string;
  reason: string;
  requestedBy: HumanControlRequestedBy;
  connId?: string;
  origin?: HumanControlOrigin;
  documentId?: string;
  cookieFingerprint?: string;
  now?: number;
};

export type HumanControlActivityInput = {
  profile: string;
  targetId: string;
  tabId?: string;
  token: string;
  origin?: HumanControlOrigin;
  documentId?: string;
  cookieFingerprint?: string;
  now?: number;
};

export type HumanControlReleaseInput = {
  profile: string;
  targetId: string;
  tabId?: string;
  token: string;
  now?: number;
};

export class HumanControlError extends Error {
  readonly code = "ACT_HUMAN_CONTROL";
  readonly status = 423;

  constructor(
    message: string,
    readonly control: HumanControlSnapshot,
  ) {
    super(message);
    this.name = "HumanControlError";
  }
}

export function isHumanControlError(error: unknown): error is HumanControlError {
  return error instanceof HumanControlError;
}

export function readHumanControlToken(body: unknown, query?: unknown): string | undefined {
  const fromBody = (body as { humanControlToken?: unknown } | null)?.humanControlToken;
  if (typeof fromBody === "string" && fromBody.length > 0) {
    return fromBody;
  }
  const fromQuery = (query as { humanControlToken?: unknown } | null)?.humanControlToken;
  return typeof fromQuery === "string" && fromQuery.length > 0 ? fromQuery : undefined;
}

/** Throw a HumanControlError unless the caller is the active human owner. */
export function assertHumanControlAgentAllowed(params: {
  profile: string;
  tab: { targetId: string; tabId?: string };
  body?: unknown;
  query?: unknown;
  token?: string;
}): void {
  const token = params.token ?? readHumanControlToken(params.body, params.query);
  humanControlRegistry.assertAgentAllowed({
    profile: params.profile,
    targetId: params.tab.targetId,
    ...(params.tab.tabId ? { tabId: params.tab.tabId } : {}),
    ...(token ? { humanToken: token } : {}),
  });
}

type JsonResponder = {
  status(code: number): { json(body: unknown): void };
};

/** Return the standard lease rejection shape to an agent or panel request. */
export function rejectHumanControl(res: JsonResponder, error: HumanControlError): void {
  res.status(423).json({
    error: error.message,
    code: error.code,
    status: "needs_human",
    reasonCode: "human_control",
    control: { ...error.control },
  });
}

/** Structured needs_human payload for agent vault responses. */
export function humanControlNeedsHuman(error: HumanControlError): {
  ok: false;
  status: "needs_human";
  reasonCode: "human_control";
  control: HumanControlSnapshot;
} {
  return {
    ok: false,
    status: "needs_human",
    reasonCode: "human_control",
    control: { ...error.control },
  };
}

export function humanControlLeaseKey(params: {
  profile: string;
  targetId: string;
  tabId?: string;
}): string {
  return `${params.profile}\u0000${params.tabId ?? params.targetId}`;
}

function boundedReason(reason: unknown): string {
  if (typeof reason !== "string") {
    return "agent_needs_human";
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return "agent_needs_human";
  }
  return trimmed.slice(0, MAX_REASON_LENGTH);
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function tokensEqual(expected: Buffer, token: string): boolean {
  const actual = hashToken(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function defaultRandomToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Owns human-control lease records for one browser runtime. The registry is
 * intentionally not persisted: a Gateway restart loses human ownership and the
 * agent starts with a clean tab.
 */
export class HumanControlRegistry {
  private readonly leases = new Map<string, HumanControlRecord>();
  private generation = 0;

  constructor(private readonly randomToken: () => string = defaultRandomToken) {}

  private prune(now: number): void {
    for (const [key, record] of this.leases) {
      if (record.control.expiresAtMs <= now || record.absoluteExpiresAtMs <= now) {
        this.leases.delete(key);
      }
    }
    if (this.leases.size <= MAX_LEASES) {
      return;
    }
    const ordered = [...this.leases.entries()].toSorted(
      ([, left], [, right]) => left.control.expiresAtMs - right.control.expiresAtMs,
    );
    for (const [key] of ordered.slice(0, this.leases.size - MAX_LEASES)) {
      this.leases.delete(key);
    }
  }

  private snapshot(record: HumanControlRecord): HumanControlSnapshot {
    return { ...record.control };
  }

  /** Read the current lease without extending it. */
  status(params: { profile: string; targetId: string; tabId?: string; now?: number }) {
    const now = params.now ?? Date.now();
    this.prune(now);
    const record = this.leases.get(humanControlLeaseKey(params));
    return record ? this.snapshot(record) : null;
  }

  /**
   * Pause agent actions for a tab. An agent request never issues a token; the
   * human must claim the lease from the Control UI before sensitive input is
   * accepted. A human claim replaces any pending agent request.
   */
  claim(input: HumanControlClaimInput): HumanControlClaimResult {
    const now = input.now ?? Date.now();
    this.prune(now);
    const key = humanControlLeaseKey(input);
    const existing = this.leases.get(key);
    if (existing && input.requestedBy === "agent") {
      // An agent can pause an agent-owned tab, but it must never replace an
      // active human lease or invalidate the human's capability.
      if (existing.control.status === "requested") {
        existing.control.expiresAtMs = Math.min(
          existing.absoluteExpiresAtMs,
          now + HUMAN_CONTROL_REQUEST_TTL_MS,
        );
        existing.control.reason = boundedReason(input.reason);
      }
      return { control: this.snapshot(existing), token: "" };
    }
    const token = this.randomToken();
    this.generation += 1;
    const ttl =
      input.requestedBy === "agent" ? HUMAN_CONTROL_REQUEST_TTL_MS : HUMAN_CONTROL_ACTIVE_TTL_MS;
    const control: HumanControlSnapshot = {
      owner: "human",
      status: input.requestedBy === "agent" ? "requested" : "active",
      reason: boundedReason(input.reason),
      requestedBy: input.requestedBy,
      profile: input.profile,
      targetId: input.targetId,
      ...(input.tabId ? { tabId: input.tabId } : {}),
      generation: this.generation,
      claimedAtMs: now,
      expiresAtMs: now + ttl,
    };
    this.leases.set(key, {
      key,
      control,
      tokenHash: hashToken(token),
      ...(input.connId ? { connId: input.connId } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.documentId ? { documentId: input.documentId } : {}),
      ...(input.cookieFingerprint ? { cookieFingerprint: input.cookieFingerprint } : {}),
      absoluteExpiresAtMs: now + HUMAN_CONTROL_MAX_DURATION_MS,
    });
    // An agent request pauses the tab but cannot act on it: only the Control UI
    // that explicitly claims the lease receives the capability token.
    return {
      control: this.snapshot(this.leases.get(key)!),
      token: input.requestedBy === "agent" ? "" : token,
    };
  }

  /**
   * Validate a human capability and extend the lease. Every human interaction
   * renews the inactivity window; the absolute cap still bounds a stuck lease.
   */
  authorizeHuman(input: HumanControlActivityInput): HumanControlSnapshot | null {
    const now = input.now ?? Date.now();
    this.prune(now);
    const key = humanControlLeaseKey(input);
    const record = this.leases.get(key);
    if (!record || record.control.status !== "active") {
      return null;
    }
    if (!tokensEqual(record.tokenHash, input.token)) {
      return null;
    }
    record.control.expiresAtMs = Math.min(
      record.absoluteExpiresAtMs,
      now + HUMAN_CONTROL_ACTIVE_TTL_MS,
    );
    if (input.origin) {
      record.origin = input.origin;
    }
    if (input.documentId) {
      record.documentId = input.documentId;
    }
    if (input.cookieFingerprint) {
      record.cookieFingerprint = input.cookieFingerprint;
    }
    return this.snapshot(record);
  }

  /** The claimed origin/document recorded when the human last interacted. */
  baseline(params: { profile: string; targetId: string; tabId?: string; now?: number }): {
    control: HumanControlSnapshot;
    origin?: HumanControlOrigin;
    documentId?: string;
    cookieFingerprint?: string;
    connId?: string;
  } | null {
    const now = params.now ?? Date.now();
    this.prune(now);
    const record = this.leases.get(humanControlLeaseKey(params));
    if (!record) {
      return null;
    }
    return {
      control: this.snapshot(record),
      ...(record.origin ? { origin: record.origin } : {}),
      ...(record.documentId ? { documentId: record.documentId } : {}),
      ...(record.cookieFingerprint ? { cookieFingerprint: record.cookieFingerprint } : {}),
      ...(record.connId ? { connId: record.connId } : {}),
    };
  }

  /** Remove a lease only when the caller presents the matching capability. */
  release(input: HumanControlReleaseInput): HumanControlSnapshot | null {
    const now = input.now ?? Date.now();
    this.prune(now);
    const key = humanControlLeaseKey(input);
    const record = this.leases.get(key);
    if (!record || !tokensEqual(record.tokenHash, input.token)) {
      return null;
    }
    this.leases.delete(key);
    this.generation += 1;
    return this.snapshot(record);
  }

  /**
   * Block agent interaction unless the request proves current human ownership.
   * A matching human token is forwarded by panel interaction routes; agent
   * tool calls have no way to supply it.
   */
  assertAgentAllowed(params: {
    profile: string;
    targetId: string;
    tabId?: string;
    humanToken?: string;
    now?: number;
  }): void {
    const now = params.now ?? Date.now();
    this.prune(now);
    const record = this.leases.get(humanControlLeaseKey(params));
    if (!record) {
      return;
    }
    if (params.humanToken && tokensEqual(record.tokenHash, params.humanToken)) {
      this.authorizeHuman({
        ...params,
        token: params.humanToken,
        now,
      });
      return;
    }
    throw new HumanControlError(
      record.control.status === "requested"
        ? "The browser tab is waiting for a human takeover. Ask the operator to finish the challenge, then retry."
        : "A human currently controls this browser tab. Wait for the operator to hand control back before retrying.",
      this.snapshot(record),
    );
  }

  revokeTarget(params: { profile: string; targetId: string; tabId?: string }): boolean {
    const key = humanControlLeaseKey(params);
    const deleted = this.leases.delete(key);
    if (deleted) {
      this.generation += 1;
    }
    return deleted;
  }

  /** Drop every lease claimed by a Gateway connection that ended. */
  revokeConnection(connId: string): number {
    let revoked = 0;
    for (const [key, record] of this.leases) {
      if (record.connId === connId) {
        this.leases.delete(key);
        revoked += 1;
      }
    }
    if (revoked > 0) {
      this.generation += 1;
    }
    return revoked;
  }

  revokeProfile(profile: string): number {
    let revoked = 0;
    for (const [key, record] of this.leases) {
      if (record.control.profile === profile) {
        this.leases.delete(key);
        revoked += 1;
      }
    }
    if (revoked > 0) {
      this.generation += 1;
    }
    return revoked;
  }

  /**
   * Drop leases whose logical tab disappeared from an authoritative tab list.
   * Alias migration keeps a lease with the same logical tab; a real close
   * removes the alias and therefore the lease.
   */
  retainProfileTabs(profile: string, liveKeys: ReadonlySet<string>): number {
    let revoked = 0;
    for (const [key, record] of this.leases) {
      if (record.control.profile !== profile) {
        continue;
      }
      const tabKey = record.control.tabId ?? record.control.targetId;
      if (!liveKeys.has(tabKey)) {
        this.leases.delete(key);
        revoked += 1;
      }
    }
    if (revoked > 0) {
      this.generation += 1;
    }
    return revoked;
  }

  revokeAll(): void {
    if (this.leases.size > 0) {
      this.generation += 1;
    }
    this.leases.clear();
  }

  activeCount(now = Date.now()): number {
    this.prune(now);
    return this.leases.size;
  }
}

/** Process-local owner; browser runtime shutdown clears it explicitly. */
export const humanControlRegistry = new HumanControlRegistry();

export function clearAllHumanControlLeases(): void {
  humanControlRegistry.revokeAll();
}
