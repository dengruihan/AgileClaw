import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";

export type ModelSetupConnection = Pick<
  ApplicationContext["gateway"]["snapshot"],
  "client" | "hello"
> & {
  agentId: string | null;
};

/** Embedded discovery always configures the selected agent's credential store. */
export function captureModelSetupConnection(
  context: ApplicationContext,
  previousRecoveryScope: string | null = null,
) {
  const snapshot = context.gateway.snapshot;
  const selection = context.settingsAgentSelection;
  return {
    client: snapshot.client,
    hello: snapshot.hello,
    agentId: selection.state.selectedId,
    selectionIntentRevision: selection.intentRevision,
    selectionPending:
      selection.state.selectedId === null && context.agents.state.agentsList === null,
    connected: snapshot.phase === "connected",
    connectionRevision: context.gateway.connectionRevision,
    // Hello owns authentication; retain its scope only while disconnected.
    recoveryScope:
      snapshot.phase === "connected"
        ? (snapshot.hello?.auth?.recoveryScope ?? null)
        : previousRecoveryScope,
  };
}

type ConnectionSnapshot = ReturnType<typeof captureModelSetupConnection>;

export function modelSetupOwnerChanges(
  previous: ConnectionSnapshot | null,
  connection: ConnectionSnapshot,
) {
  const authenticatedOwnerLost =
    previous && (!connection.recoveryScope || connection.recoveryScope !== previous.recoveryScope);
  const ownerChanged =
    previous &&
    (connection.agentId !== previous.agentId ||
      connection.selectionIntentRevision !== previous.selectionIntentRevision ||
      connection.connectionRevision !== previous.connectionRevision ||
      authenticatedOwnerLost);
  return { authenticatedOwnerLost, ownerChanged };
}

export function reconcileModelSetupConnection(
  previous: ConnectionSnapshot | null,
  connection: ConnectionSnapshot,
): { kind: "unchanged" | "pending" | "changed"; connection: ConnectionSnapshot } {
  // An unloaded roster with unchanged intent is not a different discovery owner.
  // Keep the admitted owner blocked until selection is validated again.
  if (
    previous &&
    connection.selectionPending &&
    connection.selectionIntentRevision === previous.selectionIntentRevision &&
    connection.connectionRevision === previous.connectionRevision &&
    (!connection.connected ||
      (connection.recoveryScope &&
        connection.recoveryScope === previous.recoveryScope &&
        hasOperatorAdminAccess(connection.hello?.auth ?? null)))
  ) {
    return {
      kind: previous.selectionPending ? "unchanged" : "pending",
      connection: { ...previous, selectionPending: true },
    };
  }
  const unchanged =
    previous &&
    connection.client === previous.client &&
    connection.hello === previous.hello &&
    connection.agentId === previous.agentId &&
    connection.connected === previous.connected &&
    connection.connectionRevision === previous.connectionRevision &&
    connection.recoveryScope === previous.recoveryScope &&
    connection.selectionIntentRevision === previous.selectionIntentRevision &&
    connection.selectionPending === previous.selectionPending;
  return { kind: unchanged ? "unchanged" : "changed", connection };
}
