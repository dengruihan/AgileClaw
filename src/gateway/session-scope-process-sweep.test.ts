import { afterEach, expect, it, vi } from "vitest";
import { addSession, markExited } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { sweepSessionScopeBackgroundProcesses } from "./session-scope-process-sweep.js";

const { cancel } = vi.hoisted(() => ({ cancel: vi.fn(() => true) }));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ cancel }),
}));

afterEach(() => {
  resetProcessRegistryForTests();
  cancel.mockClear();
});

const seed = (id: string, scopeKey: string, agentId = "main") => {
  const session = createProcessSessionFixture({ id, backgrounded: true, startedAt: 1 });
  session.scopeKey = scopeKey;
  session.agentId = agentId;
  session.processActivity = { resultSettled: false, lastOutputAtMs: session.startedAt };
  addSession(session);
  return session;
};

it("stops only cancellable processes inside the stopped session's scope", () => {
  seed("scoped-process", "agent:main:scoped");
  const foreign = seed("foreign-process", "agent:main:other-session");
  const exited = seed("exited-process", "agent:main:scoped");
  markExited(exited, 0, null, "completed");

  const swept = sweepSessionScopeBackgroundProcesses({
    scopeKeys: ["agent:main:scoped", "scoped-session-id"],
    agentId: "main",
  });

  expect(swept).toEqual([{ processId: "scoped-process", requested: true }]);
  expect(cancel).toHaveBeenCalledExactlyOnceWith("scoped-process", "manual-cancel");
  expect(foreign.exited).toBeFalsy();
});
