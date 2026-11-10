// Read-only saved-pairing report: whether a node credential can reconnect without a setup code.
import { formatErrorMessage } from "../../infra/errors.js";
import { loadResumableNodeHostGateway } from "../../node-host/resumable-gateway.js";
import { defaultRuntime, writeRuntimeJson } from "../../runtime.js";

export type NodePairingOutputOptions = {
  json?: boolean;
};

export async function runNodePairingStatus(opts: NodePairingOutputOptions = {}) {
  const json = Boolean(opts.json);
  let resumable: boolean;
  try {
    resumable = (await loadResumableNodeHostGateway()) !== undefined;
  } catch (error) {
    const message = `Node pairing check failed: ${formatErrorMessage(error)}`;
    if (json) {
      throw new Error(message, { cause: error });
    }
    defaultRuntime.error(message);
    defaultRuntime.exit(1);
    return;
  }
  if (json) {
    writeRuntimeJson(defaultRuntime, { resumable }, 0);
    return;
  }
  defaultRuntime.log(
    resumable
      ? "Pairing: the saved device credential can reconnect without a setup code."
      : "Pairing: no saved device credential can reconnect; pair with a setup code or join URL.",
  );
}
