/**
 * Turn-boundary device-scope prompt fact.
 *
 * M64 owns the fact's rendering; this module produces the snapshot the turn
 * owner publishes and hands to the runtime-facts builder. One snapshot per turn
 * per session keeps the fact fresh without polling the registry or the session
 * store mid-turn, and the current scope never enters the stable prefix.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  publishSessionDeviceScopePrompt,
  resolveSessionScopeRoot,
} from "../../gateway/server-methods/session-device-scope.js";
import {
  publishPromptDeviceScopeSnapshot,
  type PromptDeviceScopeSnapshot,
} from "../prompt-device-scope.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";

/**
 * Publish and return this turn's device-scope snapshot. Outside the Gateway
 * process (standalone CLI runs) there is no live registry, so nothing is
 * published and the prompt omits the fact instead of guessing a scope.
 */
export function resolveTurnDeviceScopePrompt(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId: string;
}): PromptDeviceScopeSnapshot | undefined {
  const sessionKey = params.sessionKey?.trim();
  const context = getInProcessGatewayToolContext();
  if (!sessionKey || !context) {
    return undefined;
  }
  const root = resolveSessionScopeRoot({
    cfg: params.cfg,
    sessionKey,
    agentId: params.agentId,
  });
  if (!root) {
    // The session is gone or unseen: withdraw the fact rather than render stale scope.
    publishPromptDeviceScopeSnapshot({ sessionKey });
    return undefined;
  }
  const snapshot = publishSessionDeviceScopePrompt({
    sessionKey: root.rootSessionKey,
    registry: context.nodeRegistry,
    ...(root.entry.scopeDeviceId ? { scopeDeviceId: root.entry.scopeDeviceId } : {}),
    ...(root.entry.execCwd ? { scopeCwd: root.entry.execCwd } : {}),
    // A replaced Gateway instance or a restarted runtime invalidates the fact.
    isCurrent: () => getInProcessGatewayToolContext() === context,
  });
  if (snapshot && sessionKey !== root.rootSessionKey) {
    // A subagent shares the tree scope; exact-key readers must find it too.
    publishPromptDeviceScopeSnapshot({
      sessionKey,
      snapshot,
      isCurrent: () => getInProcessGatewayToolContext() === context,
    });
  }
  return snapshot;
}
