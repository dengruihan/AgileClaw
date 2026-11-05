import { describe, expect, it } from "vitest";
import {
  NODE_EXECUTOR_PROFILE_COMMANDS,
  NODE_OCCUPANCY_ACQUIRE_COMMAND,
  NODE_OCCUPANCY_COMMANDS,
  NODE_OCCUPANCY_MUTATING_COMMANDS,
  NODE_OCCUPANCY_RELEASE_COMMAND,
  NODE_OCCUPANCY_RENEW_COMMAND,
  NODE_OCCUPANCY_REVOKE_COMMAND,
  NODE_OCCUPANCY_STATUS_COMMAND,
  NODE_WORKER_BUNDLE_INSTALL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  isAdminOnlyNodeInvokeCommand,
  isNodeOccupancyAdmissionExemptCommand,
  isNodeOccupancyCommand,
} from "./node-commands.js";

describe("node occupancy command surfaces", () => {
  it("requires admin scope for every direct lease mutation", () => {
    for (const command of NODE_OCCUPANCY_MUTATING_COMMANDS) {
      expect(isAdminOnlyNodeInvokeCommand(command)).toBe(true);
    }
    expect(NODE_OCCUPANCY_MUTATING_COMMANDS).toEqual([
      NODE_OCCUPANCY_ACQUIRE_COMMAND,
      NODE_OCCUPANCY_RENEW_COMMAND,
      NODE_OCCUPANCY_RELEASE_COMMAND,
      NODE_OCCUPANCY_REVOKE_COMMAND,
    ]);
  });

  it("leaves status readable by a session so it can see its own lease", () => {
    expect(isAdminOnlyNodeInvokeCommand(NODE_OCCUPANCY_STATUS_COMMAND)).toBe(false);
    expect(isNodeOccupancyCommand(NODE_OCCUPANCY_STATUS_COMMAND)).toBe(true);
  });

  it("exempts the lifecycle and operator approval policy from lease admission", () => {
    for (const command of NODE_OCCUPANCY_COMMANDS) {
      expect(isNodeOccupancyAdmissionExemptCommand(command)).toBe(true);
    }
    expect(isNodeOccupancyAdmissionExemptCommand("system.execApprovals.get")).toBe(true);
    expect(isNodeOccupancyAdmissionExemptCommand("system.execApprovals.set")).toBe(true);
    expect(isNodeOccupancyAdmissionExemptCommand("system.run")).toBe(false);
    expect(isNodeOccupancyAdmissionExemptCommand("file.stat")).toBe(false);
  });

  it("advertises an executor profile without worker hosting commands", () => {
    expect(NODE_EXECUTOR_PROFILE_COMMANDS).toEqual(
      expect.arrayContaining([...NODE_OCCUPANCY_COMMANDS]),
    );
    expect(NODE_EXECUTOR_PROFILE_COMMANDS).toContain("system.run");
    expect(NODE_EXECUTOR_PROFILE_COMMANDS).toContain("computer.act");
    expect(NODE_EXECUTOR_PROFILE_COMMANDS).not.toContain(NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND);
    expect(NODE_EXECUTOR_PROFILE_COMMANDS).not.toContain(NODE_WORKER_BUNDLE_INSTALL_COMMAND);
  });
});
