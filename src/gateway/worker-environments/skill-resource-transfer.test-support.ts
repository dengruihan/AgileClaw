import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";

export { NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES } from "../../worker/node-workspace-protocol.js";

/** Local ssh-style carrier that runs workspace commands through child processes. */
export function createSshSpawnTunnel(): Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand"> {
  return {
    runWorkspaceCommand: async (command) => {
      command.assertCurrent?.();
      return new Promise((resolve, reject) => {
        const child = spawn(command.argv[0]!, command.argv.slice(1), {
          stdio: "pipe",
          signal: command.signal,
        });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (bytes) => {
          stdout += bytes;
        });
        child.stderr.on("data", (bytes) => {
          stderr += bytes;
        });
        child.on("error", reject);
        child.on("close", (code) =>
          resolve({ stdout, stderr, code, termination: "exit", signal: null, killed: false }),
        );
        child.stdin.end(command.input);
      });
    },
  };
}

export async function createNodeCarrier(root: string) {
  const home = await fs.realpath(root);
  const runtime = new NodeWorkerWorkspaceRuntime({
    root: home,
    env: { ...process.env, HOME: home, TMPDIR: home },
  });
  const binding = {
    gatewayNamespace: "gateway",
    environmentId: "environment",
    sessionId: "session",
    generation: 1,
  };
  const initial = await runtime.exec({
    ...binding,
    argv: ["node", "-e", "process.stdout.write('ready')"],
  });
  return {
    home,
    binding,
    workspace: initial.workspaceDir,
    async runWorkspaceCommand(
      command: Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0],
    ) {
      command.assertCurrent?.();
      return await runtime.exec(
        parseNodeWorkerWorkspaceExecInput(
          JSON.stringify({
            ...binding,
            argv: command.argv,
            input: command.input,
            timeoutMs: command.timeoutMs,
          }),
        ),
        command.signal,
      );
    },
  };
}
