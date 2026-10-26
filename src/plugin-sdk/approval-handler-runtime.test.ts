import { describe, expect, it } from "vitest";
import type { SystemAgentApprovalRequest } from "../infra/system-agent-approvals.js";
import {
  buildChannelApprovalResolvedText,
  type ResolvedApprovalView,
} from "./approval-handler-runtime.js";
import {
  buildSystemAgentApprovalResolvedText,
  formatChannelApprovalResolvedLabel,
} from "./approval-runtime.js";

type SystemAgentView = Extract<ResolvedApprovalView, { approvalKind: "system-agent" }>;

function systemAgentView(state: Partial<SystemAgentView> = {}): SystemAgentView {
  return {
    approvalKind: "system-agent",
    approvalId: "system-agent:change",
    phase: "resolved",
    title: "AgileClaw change",
    metadata: [],
    commandText: "restart the Gateway",
    operationSummary: "restart the Gateway",
    decision: "allow-once",
    ...state,
  };
}

const cases: Array<{ state: Partial<SystemAgentView>; label: string; text: string }> = [
  {
    state: {},
    label: "Allowed once",
    text: "✅ AgileClaw change approved. Applying: restart the Gateway",
  },
  {
    state: { decision: "allow-always" },
    label: "Allowed always",
    text: "✅ AgileClaw change approved. Applying: restart the Gateway",
  },
  {
    state: { decision: "deny" },
    label: "Denied",
    text: "❌ AgileClaw change denied. No change was made.",
  },
  {
    state: { applicationStatus: "applied" },
    label: "Applied",
    text: "✅ AgileClaw change approved and applied: restart the Gateway",
  },
  {
    state: { applicationStatus: "not-applied" },
    label: "Completion unconfirmed",
    text: "⚠️ AgileClaw change approved, but completion could not be confirmed. Check the current settings before retrying.",
  },
  {
    state: { decision: "deny", applicationStatus: "not-applied" },
    label: "Denied",
    text: "❌ AgileClaw change denied. No change was made.",
  },
  {
    state: { decision: "deny", applicationStatus: "applied" },
    label: "Applied",
    text: "❌ AgileClaw change denied. No change was made.",
  },
  {
    state: { decision: "deny", applicationStatus: "applied", terminalStatus: "cancelled" },
    label: "Cancelled",
    text: "⚠️ AgileClaw change was cancelled because its run ended. No change was made. Retry.",
  },
];

describe("approval terminal presentation", () => {
  it.each(cases)("preserves rich and prose precedence for $state", ({ state, label, text }) => {
    const view = systemAgentView(state);
    expect(formatChannelApprovalResolvedLabel(view)).toBe(label);
    expect(buildSystemAgentApprovalResolvedText(view)).toBe(text);
  });

  it("keeps decision spelling local without overriding application results", () => {
    const formatDecision = (decision: ResolvedApprovalView["decision"]) => `Decision: ${decision}`;
    expect(formatChannelApprovalResolvedLabel(systemAgentView(), formatDecision)).toBe(
      "Decision: allow-once",
    );
    expect(
      formatChannelApprovalResolvedLabel(
        systemAgentView({ applicationStatus: "not-applied" }),
        formatDecision,
      ),
    ).toBe("Completion unconfirmed");
  });

  it("uses the resolved event's decision for channel prose", () => {
    const request: SystemAgentApprovalRequest = {
      approvalKind: "system-agent",
      id: "system-agent:change",
      request: {
        title: "AgileClaw change",
        description: "restart the Gateway",
        command: "restart the Gateway",
        proposalHash: "a".repeat(64),
        allowedDecisions: ["allow-once", "deny"],
        sessionId: "test-session",
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    };
    expect(
      buildChannelApprovalResolvedText({
        request,
        resolved: { id: request.id, decision: "deny", ts: 1 },
        view: systemAgentView({ applicationStatus: "applied" }),
      }),
    ).toBe("❌ AgileClaw change denied. No change was made.");
  });
});
