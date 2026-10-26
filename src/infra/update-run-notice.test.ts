import { describe, expect, it } from "vitest";
import { renderUpdateRunNotice, renderUpdateRunSummary } from "./update-run-notice.js";
import type { UpdateRunRecord } from "./update-run-record.js";

describe("update conversation notices", () => {
  it.each<{
    status: UpdateRunRecord["status"];
    reason: string | null;
    headline: string;
  }>([
    { status: "succeeded", reason: null, headline: "✅ AgileClaw updated." },
    { status: "running", reason: null, headline: "⬆️ AgileClaw is updating." },
    {
      status: "failed",
      reason: "state-migrated-no-rollback",
      headline: "⚠️ AgileClaw couldn't finish updating.",
    },
    {
      status: "rolled-back",
      reason: "restart-unhealthy",
      headline: "↩️ The update couldn't finish. AgileClaw returned to the previous version.",
    },
    {
      status: "skipped",
      reason: "container-image-install",
      headline: "ℹ️ AgileClaw wasn't updated.",
    },
    {
      status: "skipped",
      reason: "already-current",
      headline: "✅ AgileClaw is already up to date.",
    },
    {
      status: "skipped",
      reason: "still-starting",
      headline: "⏳ AgileClaw is installed and still starting.",
    },
    {
      status: "skipped",
      reason: "gateway-readiness-unverified",
      headline: "⚠️ AgileClaw is installed, but we couldn't confirm it's ready.",
    },
  ])("explains $status ($reason) without suggesting a repair", ({ status, reason, headline }) => {
    const record = {
      status,
      phase: "finished" as const,
      reason,
      before: { sha: "11111111" },
      after: { sha: "22222222" },
      origin: {
        admission: { owner: "installed" },
        nextAction: "Retain /fixture/update-backups until recovery is verified.",
      },
      steps: [
        { step: "validating", status: "completed", startedAtMs: 1, endedAtMs: 1_000 },
        {
          step: "diagnostic:database snapshot",
          status: "completed",
          detail: "Databases snapshotted at /fixture/update-backups.",
        },
        { step: "warning", status: "completed", detail: "SecretRef-managed token warning" },
      ],
    };
    const saved = structuredClone(record);
    const text = renderUpdateRunSummary(record);
    expect(renderUpdateRunNotice(record, "finished")).toBe(status === "running" ? null : text);
    expect(record).toEqual(saved);
    expect(text.split("\n")).toEqual([
      headline,
      "For details, open Settings → Updates in the Control UI or run `openclaw update status` in your terminal.",
    ]);
  });

  it("only announces the current milestone", () => {
    const requested = { status: "running" as const, phase: "requested" as const, reason: null };
    expect(renderUpdateRunNotice(requested, "parking")).toBe("⏳ Restarting AgileClaw…");
    expect(renderUpdateRunNotice(requested, "activating")).toBeNull();
    expect(renderUpdateRunNotice(requested, "verifying")).toBeNull();
    expect(renderUpdateRunNotice(requested, "finished")).toBeNull();
    for (const phase of ["staging", "activating", "verifying"] as const) {
      const progressed = { ...requested, phase };
      expect(renderUpdateRunNotice(progressed, "parking")).toBeNull();
      expect(renderUpdateRunNotice(progressed, "ack")).toBeNull();
    }
    expect(
      renderUpdateRunNotice({ status: "succeeded", phase: "finished", reason: null }, "parking"),
    ).toBeNull();
  });
});
