import { describe, expect, it } from "vitest";
import {
  HUMAN_CONTROL_ACTIVE_TTL_MS,
  HUMAN_CONTROL_REQUEST_TTL_MS,
  HumanControlError,
  HumanControlRegistry,
  humanControlLeaseKey,
} from "./human-control.js";

function registry() {
  let counter = 0;
  return new HumanControlRegistry(() => `token-${++counter}`);
}

const base = { profile: "openclaw", targetId: "target-1", tabId: "t1" };

describe("HumanControlRegistry", () => {
  it("pauses agent actions while the human owns the tab", () => {
    const leases = registry();
    const claimed = leases.claim({ ...base, reason: "user_request", requestedBy: "human" });
    expect(claimed.control.status).toBe("active");
    expect(claimed.token).toBe("token-1");

    expect(() => leases.assertAgentAllowed(base)).toThrowError(HumanControlError);
    expect(() => leases.assertAgentAllowed({ ...base, humanToken: claimed.token })).not.toThrow();

    expect(leases.release({ ...base, token: claimed.token })).toMatchObject({
      owner: "human",
      status: "active",
    });
    expect(() => leases.assertAgentAllowed(base)).not.toThrow();
  });

  it("keeps an agent-requested takeover unclaimable without a capability token", () => {
    const leases = registry();
    const requested = leases.claim({
      ...base,
      reason: "captcha",
      requestedBy: "agent",
      connId: "conn-1",
    });
    expect(requested.control.status).toBe("requested");
    expect(requested.token).toBe("");

    expect(leases.authorizeHuman({ ...base, token: requested.token })).toBeNull();
    expect(() => leases.assertAgentAllowed(base)).toThrowError(/waiting for a human takeover/u);

    const human = leases.claim({ ...base, reason: "captcha", requestedBy: "human" });
    expect(human.control.status).toBe("active");
    expect(human.token).toBe("token-2");
    expect(leases.authorizeHuman({ ...base, token: human.token })).not.toBeNull();
  });

  it("never lets an agent request replace an active human lease", () => {
    const leases = registry();
    const human = leases.claim({ ...base, reason: "captcha", requestedBy: "human" });
    const agent = leases.claim({ ...base, reason: "two_factor", requestedBy: "agent" });

    expect(agent.token).toBe("");
    expect(agent.control).toMatchObject({ status: "active", requestedBy: "human" });
    expect(() => leases.assertAgentAllowed({ ...base, humanToken: human.token })).not.toThrow();
    expect(leases.release({ ...base, token: human.token })).not.toBeNull();
  });

  it("rejects stale capabilities after a re-claim", () => {
    const leases = registry();
    const first = leases.claim({ ...base, reason: "user_request", requestedBy: "human" });
    const second = leases.claim({ ...base, reason: "user_request", requestedBy: "human" });
    expect(() => leases.assertAgentAllowed({ ...base, humanToken: first.token })).toThrow();
    expect(leases.release({ ...base, token: first.token })).toBeNull();
    expect(() => leases.assertAgentAllowed({ ...base, humanToken: second.token })).not.toThrow();
  });

  it("expires requested and active leases on their own TTLs", () => {
    const leases = registry();
    const now = 1_000_000;
    leases.claim({
      ...base,
      reason: "captcha",
      requestedBy: "agent",
      now,
    });
    expect(leases.status({ ...base, now: now + HUMAN_CONTROL_REQUEST_TTL_MS - 1 })).not.toBeNull();
    expect(leases.status({ ...base, now: now + HUMAN_CONTROL_REQUEST_TTL_MS + 1 })).toBeNull();

    leases.claim({ ...base, reason: "user_request", requestedBy: "human", now });
    const active = leases.status({ ...base, now });
    expect(active?.expiresAtMs).toBe(now + HUMAN_CONTROL_ACTIVE_TTL_MS);
    expect(leases.status({ ...base, now: now + HUMAN_CONTROL_ACTIVE_TTL_MS + 1 })).toBeNull();
  });

  it("renews an active lease on human activity but never past the absolute cap", () => {
    const leases = registry();
    const now = 1_000_000;
    const claimed = leases.claim({ ...base, reason: "two_factor", requestedBy: "human", now });
    const renewedAt = now + 4 * 60_000;
    const renewed = leases.authorizeHuman({ ...base, token: claimed.token, now: renewedAt });
    expect(renewed?.expiresAtMs).toBe(renewedAt + HUMAN_CONTROL_ACTIVE_TTL_MS);

    const capped = leases.authorizeHuman({
      ...base,
      token: claimed.token,
      now: now + 40 * 60_000,
    });
    expect(capped).toBeNull();
  });

  it("revokes leases for a disconnected connection and for closed tabs", () => {
    const leases = registry();
    leases.claim({
      ...base,
      reason: "user_request",
      requestedBy: "human",
      connId: "conn-a",
    });
    leases.claim({
      profile: "openclaw",
      targetId: "target-2",
      tabId: "t2",
      reason: "user_request",
      requestedBy: "human",
      connId: "conn-b",
    });
    expect(leases.revokeConnection("conn-a")).toBe(1);
    expect(leases.status(base)).toBeNull();
    expect(
      leases.status({ profile: "openclaw", targetId: "target-2", tabId: "t2" }),
    ).not.toBeNull();

    const keepKey = humanControlLeaseKey({
      profile: "openclaw",
      targetId: "target-2",
      tabId: "t2",
    });
    expect(keepKey.endsWith("\u0000t2")).toBe(true);
    expect(leases.retainProfileTabs("openclaw", new Set(["t2"]))).toBe(0);
    expect(leases.retainProfileTabs("openclaw", new Set())).toBe(1);
    expect(leases.activeCount()).toBe(0);
  });

  it("keys ownership by the stable tab alias across a target replacement", () => {
    const leases = registry();
    leases.claim({ ...base, reason: "user_request", requestedBy: "human" });
    expect(
      leases.status({ profile: "openclaw", targetId: "target-new", tabId: "t1" }),
    ).toMatchObject({ status: "active", targetId: "target-1" });
    expect(leases.status({ profile: "openclaw", targetId: "target-new" })).toBeNull();
  });
});
