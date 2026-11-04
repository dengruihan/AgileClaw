/**
 * Delivery-receipt ledger for one source's accepted contributions. Queued,
 * installed, and submitted are distinct facts — host acceptance never claims
 * the model saw the material — and terminal receipts are never rewritten.
 */

export const TURN_CONTEXT_RECEIPT_STATUSES = [
  "queued",
  "leased",
  "installed",
  "submitted",
  "uncertain",
  "dropped",
] as const;
export type TurnContextReceiptStatus = (typeof TURN_CONTEXT_RECEIPT_STATUSES)[number];

export type TurnContextReceipt = {
  status: TurnContextReceiptStatus;
  reason?: string;
};

// The terminal continuation installs straight from the queue; the model
// boundary leases first. Both are legitimate entry points to installed.
const RECEIPT_TRANSITIONS: Record<TurnContextReceiptStatus, readonly TurnContextReceiptStatus[]> = {
  queued: ["leased", "installed", "dropped"],
  leased: ["installed", "dropped"],
  installed: ["submitted", "uncertain", "dropped"],
  uncertain: [],
  submitted: [],
  dropped: [],
};

// Only host-owned categories cross the operational log boundary. Caller-supplied
// reason strings may contain request material and must never become log keys.
const LOGGED_DROP_REASONS = new Set([
  "input-closed",
  "source-closed",
  "authority-revoked",
  "token-budget",
  "installation-failed-or-revoked",
  "authority-revoked-after-install",
  "run-settled",
  "terminal-closed",
]);

export type TurnContextReceiptLedger = {
  recordQueued(contributionId: string): void;
  transition(contributionId: string, status: TurnContextReceiptStatus, reason?: string): void;
  dropPending(reason: string): void;
  counts(): Record<TurnContextReceiptStatus, number>;
  droppedReasonCounts(): Map<string, number>;
};

/** Bounded by the source's accepted-contribution cap. */
export function createTurnContextReceiptLedger(): TurnContextReceiptLedger {
  const receipts = new Map<string, TurnContextReceipt>();
  return {
    recordQueued(contributionId) {
      receipts.set(contributionId, { status: "queued" });
    },
    transition(contributionId, status, reason) {
      const current = receipts.get(contributionId);
      if (!current || !RECEIPT_TRANSITIONS[current.status].includes(status)) {
        return;
      }
      receipts.set(contributionId, reason ? { status, reason } : { status });
    },
    dropPending(reason) {
      for (const [id, receipt] of receipts) {
        if (RECEIPT_TRANSITIONS[receipt.status].includes("dropped")) {
          receipts.set(id, { status: "dropped", reason });
        }
      }
    },
    counts() {
      const counts: Record<TurnContextReceiptStatus, number> = {
        queued: 0,
        leased: 0,
        installed: 0,
        submitted: 0,
        uncertain: 0,
        dropped: 0,
      };
      for (const receipt of receipts.values()) {
        counts[receipt.status] += 1;
      }
      return counts;
    },
    droppedReasonCounts() {
      const counts = new Map<string, number>();
      for (const receipt of receipts.values()) {
        if (receipt.status !== "dropped") {
          continue;
        }
        const reason =
          receipt.reason && LOGGED_DROP_REASONS.has(receipt.reason) ? receipt.reason : "other";
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
      }
      return counts;
    },
  };
}
