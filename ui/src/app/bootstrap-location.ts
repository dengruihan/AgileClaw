import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { RouteLocation } from "@openclaw/uirouter";
import type { ModelCatalogTarget } from "../../../packages/gateway-protocol/src/index.js";
import type { AgentsListResult } from "../api/types.ts";
import { pathForRoute, pluginSlugCandidate } from "../app-route-paths.ts";
import type { ApplicationRouter } from "../app-routes.ts";
import { pathForSession } from "../app-session-path-builder.ts";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import { parseCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import {
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import { resolveChatSnapshotKey } from "../pages/chat/session-snapshot-key.ts";
import { newSessionLocationFromSearch } from "../pages/new-session/location.ts";
import type { ApplicationContext, ApplicationGateway } from "./context.ts";
import { newSessionLandingLocation } from "./default-landing.ts";
import { waitForGatewayClient } from "./gateway-readiness.ts";
import { releasedSessionQuery, resolvePersistedAgentId } from "./released-session-query.ts";
import { loadGatewaySessionSelection } from "./settings.ts";

async function normalizeReleasedSessionQueryLocation(params: {
  location: RouteLocation;
  basePath: string;
  gateway: Pick<ApplicationGateway, "snapshot" | "subscribe">;
  agentsList: () => AgentsListResult | null;
  selectedAgentId?: string | null;
  signal: AbortSignal;
}): Promise<RouteLocation | null> {
  const released = releasedSessionQuery(params.location, params.basePath);
  if (!released) {
    return null;
  }
  const defaultsKnown = Boolean(
    params.agentsList()?.mainKey?.trim() ||
    (params.gateway.snapshot.phase === "connected" && params.gateway.snapshot.hello),
  );
  const parsed = parseAgentSessionKey(released.sessionKey);
  if (released.sessionKey && !defaultsKnown) {
    await waitForGatewayClient(params.gateway, params.signal);
  }
  const defaults = {
    agentsList: params.agentsList(),
    hello: params.gateway.snapshot.hello,
  };
  const agentId =
    parsed?.agentId ??
    (resolvePersistedAgentId(params.selectedAgentId, defaults.agentsList) ||
      resolveUiDefaultAgentId(defaults));
  if (!released.sessionKey) {
    // A released link without a key is a plain chat entry: open a new draft.
    return newSessionLandingLocation(params.location, params.basePath, agentId);
  }
  const mainKey = resolveUiConfiguredMainKey(defaults);
  const pathname = pathForSession(released.face, agentId, released.sessionKey, params.basePath, {
    mainKey,
  });
  const search = new URLSearchParams(params.location.search);
  search.delete("session");
  search.delete("face");
  const nextSearch = search.toString();
  return {
    ...params.location,
    pathname: pathname ?? pathForRoute(released.face, params.basePath),
    search: nextSearch ? `?${nextSearch}` : "",
  };
}

export function resolveBootstrapModelCatalogTarget(
  location: RouteLocation,
  basePath: string,
  gatewayUrl: string,
): ModelCatalogTarget | undefined {
  if (pluginSlugCandidate(location.pathname, basePath)) {
    return undefined;
  }
  const routeId = routeIdForLocation(location.pathname, basePath);
  if (routeId === "new-session") {
    const agentId = newSessionLocationFromSearch(location.search).agentId;
    return agentId ? { agentId } : {};
  }
  if (routeId === "model-providers") {
    const selection = loadGatewaySessionSelection(gatewayUrl);
    return selection.selectedAgentId ? { agentId: selection.selectedAgentId } : {};
  }
  const target = sessionRefFromPath(location.pathname, basePath);
  if (target?.kind === "literal") {
    return { agentId: target.agentId, sessionKey: target.sessionKey };
  }
  if (target?.kind === "main") {
    return {
      agentId: target.agentId,
      sessionKey: buildAgentMainSessionKey({ agentId: target.agentId }),
    };
  }
  if (target?.kind === "short") {
    return {
      agentId: target.agentId,
      shortId: target.shortId,
      ...(target.slugHint ? { slugHint: target.slugHint } : {}),
    };
  }
  return undefined;
}

function routeIdForLocation(pathname: string, basePath: string): string | null {
  if (pathname === pathForRoute("new-session", basePath)) {
    return "new-session";
  }
  if (pathname === pathForRoute("model-providers", basePath)) {
    return "model-providers";
  }
  return null;
}

export function isReleasedSessionLocation(location: RouteLocation, basePath: string): boolean {
  return releasedSessionQuery(location, basePath) !== null;
}

/** Resolve legacy released `?session=` links to their canonical session path. */
export function resolveInitialApplicationLocation(params: {
  location: RouteLocation;
  basePath: string;
  gateway: Pick<ApplicationGateway, "snapshot" | "subscribe">;
  agentsList: () => AgentsListResult | null;
  selectedAgentId?: string | null;
  signal: AbortSignal;
}): Promise<RouteLocation> {
  return normalizeReleasedSessionQueryLocation(params).then(
    (released) => released ?? params.location,
  );
}

/** Install a resolved location only while the requested entry is still current. */
export async function installResolvedInitialLocation(params: {
  history: { location: () => RouteLocation };
  expectedLocation: RouteLocation;
  resolvedLocation: Promise<RouteLocation>;
  install: (location: RouteLocation) => void | Promise<void>;
}): Promise<void> {
  const resolved = await params.resolvedLocation;
  const current = params.history.location();
  if (
    current.pathname !== params.expectedLocation.pathname ||
    current.search !== params.expectedLocation.search ||
    current.hash !== params.expectedLocation.hash
  ) {
    return;
  }
  await params.install(resolved);
}

/** Bind route and selection facts to the connection scheduler before roster hydration subscribes. */
export function subscribeForegroundChatBootstrap({
  router,
  gateway,
  agents,
  agentSelection,
  connectionBootstrap,
  initialChatRoute,
  chatSubmissions,
}: Pick<
  ApplicationContext,
  "gateway" | "agents" | "agentSelection" | "connectionBootstrap" | "chatSubmissions"
> & {
  router: ApplicationRouter;
  initialChatRoute: boolean;
}): () => void {
  connectionBootstrap.setForegroundRoute(initialChatRoute ? undefined : null);
  const stopConnection = gateway.subscribe((snapshot) => {
    connectionBootstrap.synchronize({
      client: snapshot.client,
      connected: snapshot.phase === "connected",
    });
  });
  const synchronizeRoute = (state: ReturnType<ApplicationRouter["getState"]>) => {
    const match = state.pendingMatches[0] ?? state.matches[0];
    if (!match && state.status === "idle") {
      return;
    }
    const data = asOptionalRecord(match?.data);
    const key =
      data?.kind === "session" && typeof data.sessionKey === "string" ? data.sessionKey : null;
    // Admission previews have no transcript controller and cannot claim its
    // bootstrap priority. Resume ordinary scheduling until the real pane mounts.
    connectionBootstrap.setForegroundRoute(
      match?.routeId !== "chat" || chatSubmissions.creation
        ? null
        : match.status === "pending"
          ? undefined
          : match.status === "success" && key && !parseCatalogSessionKey(key)
            ? resolveChatSnapshotKey(
                {
                  settings: gateway.connection,
                  client: gateway.snapshot.client,
                  agentsList: agents.state.agentsList,
                  hello: gateway.snapshot.hello,
                  assistantAgentId: agentSelection.state.selectedId,
                },
                {
                  sessionKey: key,
                  agentId: typeof data?.agentId === "string" ? data.agentId : undefined,
                },
              )
            : null,
    );
  };
  const synchronize = () => synchronizeRoute(router.getState());
  const stops = [
    stopConnection,
    router.subscribe(synchronizeRoute),
    agentSelection.subscribe(synchronize),
    chatSubmissions.subscribeCreate(synchronize),
  ];
  return () => stops.forEach((stop) => stop());
}
