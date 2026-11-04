import type { RouteLocation } from "@openclaw/uirouter";
import {
  INTERNAL_SESSION_PATH_PARAM,
  pathForRoute,
  pluginSlugCandidate,
  routeIdFromPath,
} from "../app-route-paths.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import type { ApplicationContext } from "./context.ts";

/** Bare root and bare Chat open a new unsent draft; explicit session links stay untouched. */
export function isNewSessionLanding(location: RouteLocation, basePath: string): boolean {
  const search = new URLSearchParams(location.search + "&" + location.hash.slice(1));
  return (
    !search.has("session") &&
    !search.has("draft") &&
    !search.has("catalog") &&
    // The router hands the chat loader a rewritten bare /chat with the real
    // session path in this parameter; that location is an explicit link.
    !search.has(INTERNAL_SESSION_PATH_PARAM) &&
    !pluginSlugCandidate(location.pathname, basePath) &&
    (routeIdFromPath(location.pathname, basePath) === null ||
      /^\/chat\/?$/u.test(location.pathname.slice(basePath.length)))
  );
}

export function newSessionLandingLocation(
  location: RouteLocation,
  basePath: string,
  agentId: string | null,
): RouteLocation {
  const agent = agentId?.trim() ?? "";
  const search = new URLSearchParams(location.search);
  search.delete("session");
  search.delete("face");
  if (agent) {
    search.set("agent", agent);
  }
  const serialized = search.toString();
  return {
    ...location,
    pathname: pathForRoute("new-session", basePath),
    search: serialized ? `?${serialized}` : "",
    hash: location.hash,
  };
}

/**
 * Settles a bare-entry draft once the Gateway answers: read-only connections
 * move to the session list, and a roster-resolved agent selection names the
 * draft. Only the replaced landing location is touched; later navigation is
 * the operator's.
 */
export function startDefaultNewSessionLanding(options: {
  gateway: Pick<ApplicationContext["gateway"], "snapshot" | "subscribe">;
  agentSelection: Pick<ApplicationContext["agentSelection"], "state" | "subscribe">;
  history: { location: () => RouteLocation };
  basePath: string;
  landingPathname: string;
  agentId: string | null;
  navigate: (location: RouteLocation) => void;
  onRetireWriteAccess?: () => void;
}): () => void {
  let agentSettled = Boolean(options.agentId?.trim());
  let writeSettled = false;
  let stopped = false;
  const isOnLanding = () => options.history.location().pathname === options.landingPathname;
  const settle = () => {
    if (stopped || !isOnLanding()) {
      return;
    }
    const snapshot = options.gateway.snapshot;
    if (snapshot.phase !== "connected" || !snapshot.client) {
      return;
    }
    if (!writeSettled) {
      const access = readSessionMethodAccess(snapshot, { method: "sessions.create", params: {} });
      if (!access.allowed) {
        options.navigate({
          pathname: pathForRoute("sessions", options.basePath),
          search: "",
          hash: "",
        });
        options.onRetireWriteAccess?.();
        return;
      }
      writeSettled = true;
    }
    if (!agentSettled) {
      const selected = options.agentSelection.state.selectedId;
      if (selected) {
        options.navigate(
          newSessionLandingLocation(
            { ...options.history.location(), pathname: options.landingPathname },
            options.basePath,
            selected,
          ),
        );
      }
      agentSettled = true;
    }
    if (writeSettled && agentSettled) {
      stop();
    }
  };
  const stops = [options.gateway.subscribe(settle), options.agentSelection.subscribe(settle)];
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const unsubscribe of stops) {
      unsubscribe();
    }
  };
  settle();
  return stop;
}
