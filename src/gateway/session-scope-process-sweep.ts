import {
  readBackgroundProcesses,
  stopBackgroundProcess,
  type ProcessObservationScope,
} from "../agents/bash-process-observation.js";

/**
 * Stop-path sweep for device-scoped sessions: detached background processes
 * keep the node lease alive after the session goes idle, so the only manual
 * release path (Stop) must also cancel every cancellable process still running
 * under the stopped session's scope. Process liveness stays owned by the
 * in-memory registry; this sweep is best effort and reports what it requested.
 */
export function sweepSessionScopeBackgroundProcesses(
  scope: ProcessObservationScope,
): { processId: string; requested: boolean }[] {
  const { processes } = readBackgroundProcesses(scope);
  return processes.flatMap((process) =>
    process.canStop
      ? [
          {
            processId: process.processId,
            requested: stopBackgroundProcess(scope, {
              processId: process.processId,
              instanceId: process.instanceId,
            }).requested,
          },
        ]
      : [],
  );
}
