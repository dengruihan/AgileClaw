import { prepareDevicePairingBinding } from "./device-pairing-binding.js";
import { getPublishedPairedDeviceBinding } from "./device-pairing-publication.js";
import type { DevicePairingBinding } from "./device-pairing-read.types.js";
import {
  getPairedDevice,
  hasEffectivePairedDeviceRole,
  resolveNodePairingState,
  type NodePairingGeneration,
  type NodePairingState,
  type PairedDevice,
} from "./device-pairing.js";
import {
  filterPairedDeviceCommandSurface,
  isPairedDeviceEnabled,
  type PairedDeviceCommandPolicy,
} from "./device-pairing.types.js";
import type { NodeApprovalSurface } from "./node-pairing-surface.js";

export type { NodePairingGeneration } from "./device-pairing.js";

/** Registry projection of a paired device's authenticated node-role state. */
export type PairedDeviceNodeBinding = DevicePairingBinding;

/** Project only authenticated node-role bindings from the caller's loaded device snapshot. */
export function projectPairedDeviceNodeBindings(
  pairedDevices: readonly PairedDevice[],
): Map<string, PairedDeviceNodeBinding> {
  const bindings = new Map<string, PairedDeviceNodeBinding>();
  for (const device of pairedDevices) {
    const { binding } = prepareDevicePairingBinding(device.deviceId, device);
    if (binding) {
      bindings.set(device.deviceId, binding);
    }
  }
  return bindings;
}

export async function captureNodePairingState(
  nodeId: string,
  baseDir?: string,
): Promise<NodePairingState | null> {
  return resolveNodePairingState(await getPairedDevice(nodeId, baseDir));
}

export async function resolveCurrentPairedDeviceNodeBinding(
  nodeId: string,
): Promise<PairedDeviceNodeBinding | undefined> {
  await getPairedDevice(nodeId);
  return getPublishedPairedDeviceBinding(nodeId.trim()) ?? undefined;
}

export function isPairedDeviceNodeBindingCurrent(
  nodeId: string,
  expected: PairedDeviceNodeBinding,
): boolean {
  const current = getPublishedPairedDeviceBinding(nodeId.trim());
  return Boolean(
    current &&
    current.identity === expected.identity &&
    (!expected.generation || current.generation === expected.generation),
  );
}

export async function captureNodePairingGeneration(
  nodeId: string,
): Promise<NodePairingGeneration | null> {
  return (await captureNodePairingState(nodeId))?.generation ?? null;
}

/** Binds a connected session to the exact device key and node token used for authentication. */
export async function captureAuthenticatedNodePairingState(params: {
  nodeId: string;
  publicKey: string;
  token: string;
  baseDir?: string;
}): Promise<
  | (NodePairingState & {
      approvedSurface: NodeApprovalSurface;
      /** Current per-device policy so the registry can join it into runtime refreshes. */
      commandPolicy?: PairedDeviceCommandPolicy;
    })
  | null
> {
  const device = await getPairedDevice(params.nodeId, params.baseDir);
  if (
    !device ||
    device.publicKey !== params.publicKey ||
    device.tokens?.node?.token !== params.token ||
    !hasEffectivePairedDeviceRole(device, "node")
  ) {
    return null;
  }
  const state = resolveNodePairingState(device);
  if (!state) {
    return null;
  }
  // A disabled device keeps its connection identity (it stays visible and
  // connected in the inventory) but admits no command surface, and the null
  // generation excludes it from async work and placement.
  if (!isPairedDeviceEnabled(device)) {
    return { ...state, approvedSurface: { caps: [], commands: [] } };
  }
  return {
    ...state,
    ...(device.commandPolicy ? { commandPolicy: device.commandPolicy } : {}),
    approvedSurface: {
      caps: device.nodeSurface?.caps ?? [],
      commands: filterPairedDeviceCommandSurface(
        device.commandPolicy,
        device.nodeSurface?.commands ?? [],
      ),
      permissions: device.nodeSurface?.permissions,
    },
  };
}

/**
 * Distinguish a paired-but-disabled device from an absent pairing for callers
 * that must reject execution with a precise reason instead of a generic
 * pairing-changed error.
 */
export async function isPairedNodeDeviceDisabled(
  nodeId: string,
  baseDir?: string,
): Promise<boolean> {
  const device = await getPairedDevice(nodeId, baseDir);
  return Boolean(
    device && hasEffectivePairedDeviceRole(device, "node") && !isPairedDeviceEnabled(device),
  );
}

export async function isNodePairingGenerationCurrent(
  generation: NodePairingGeneration,
): Promise<boolean> {
  await getPairedDevice(generation.nodeId);
  const current = getPublishedPairedDeviceBinding(generation.nodeId);
  return current?.generation === generation.key;
}
