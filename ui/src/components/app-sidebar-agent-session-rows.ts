import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { filterVisibleSessionRows, sessionMatchesArchivedFilter } from "../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isSubagentSessionKey,
  normalizeAgentId,
  normalizeDefaultMainSessionAliasForUi,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
  resolveUiSessionRowAgentId,
} from "../lib/sessions/session-key.ts";
import { projectSidebarArchiveVisibility } from "./app-sidebar-session-archive-visibility.ts";
import { adoptedCatalogSessionKeys } from "./app-sidebar-session-catalogs.ts";
import {
  collectCategorizedChildRootRows,
  collectSidebarSessionRowsByKey,
  findSidebarSessionInTree,
  type SidebarSessionNavigationState,
} from "./app-sidebar-session-navigation-logic.ts";
import {
  collectPromotedMainChildRows,
  collectSidebarSessionChildKeys,
} from "./app-sidebar-session-parent.ts";
import { projectSessionTree } from "./app-sidebar-session-tree.ts";
import type {
  SidebarRecentSession,
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";

type AgentSessionRowsHost = {
  readonly sessionDataContext:
    | Pick<ApplicationContext, "agents" | "gateway" | "sessions">
    | undefined;
  readonly sessionData: SessionDataController;
  visibleSessionCatalogs(): readonly SessionCatalog[];
  selectedAgentMainSessionKey(agentId: string): string;
  readonly sessionsShowCron: boolean;
  readonly sessionsShowSystem: boolean;
  readonly sessionsStatusFilter: SidebarSessionStatusFilter;
  readonly sessionInvolvingMeFilterActive: boolean;
};

/** Project either sidebar scope through one sorted session forest. */
export function projectSidebarAgentSessionRows({
  host,
  navigationState,
  selected,
  agentIds,
  result,
  compareSessions,
  resolveAttention,
}: {
  host: AgentSessionRowsHost;
  navigationState: SidebarSessionNavigationState;
  selected: string;
  agentIds: readonly string[];
  result?: SessionsListResult | null;
  compareSessions: (a: GatewaySessionRow, b: GatewaySessionRow) => number;
  resolveAttention: Parameters<typeof projectSessionTree>[0]["resolveAttention"];
}): SidebarRecentSession[] {
  const grouped = result !== undefined;
  const defaultAgentId = resolveUiDefaultAgentId({
    agentsList: host.sessionDataContext?.agents.state.agentsList,
    hello: host.sessionDataContext?.gateway.snapshot.hello,
  });
  const allowedAgents = new Set(agentIds);
  const inScope = (row: GatewaySessionRow) =>
    !grouped || allowedAgents.has(resolveUiSessionRowAgentId(row, defaultAgentId));
  const lineageRoot = host.sessionData.activeSessionLineageRoot;
  const knownRows = grouped
    ? collectSidebarSessionRowsByKey({
        rows: [...(lineageRoot ? [lineageRoot] : []), ...navigationState.visibleSessionRows],
        childRowsByParent: host.sessionData.childSessionRowsByParent,
      })
    : null;
  const adopted = grouped
    ? new Set<string>()
    : adoptedCatalogSessionKeys(host.visibleSessionCatalogs());
  const loadedAgentId = normalizeAgentId(host.sessionData.sessionsAgentId ?? "");
  const routeAgentId = normalizeAgentId(navigationState.selectedAgentId);
  const visibilityOptions = {
    agentId: selected,
    defaultAgentId,
    filterByAgent: !grouped,
    showCron: host.sessionsShowCron,
    showSystem: host.sessionsShowSystem,
    archivedFilter: host.sessionsStatusFilter,
  } as const;
  const visibility = projectSidebarArchiveVisibility({
    sessionData: grouped
      ? {
          sessionsAgentId: selected,
          sessionsResult: result,
          sessionResultsByAgent: host.sessionData.sessionResultsByAgent,
          childSessionRowsByParent: host.sessionData.childSessionRowsByParent,
          loadedChildSessionKeys: host.sessionData.loadedChildSessionKeys,
          loadingChildSessionKeys: host.sessionData.loadingChildSessionKeys,
          childSessionErrorsByParent: host.sessionData.childSessionErrorsByParent,
        }
      : host.sessionData,
    selectedAgentId: selected,
    statusFilter: host.sessionsStatusFilter,
    now: Date.now(),
    deletionState: (key, agentId) =>
      host.sessionDataContext?.sessions.deletionState(
        key,
        grouped
          ? resolveUiSessionRowAgentId(knownRows?.get(key) ?? { key }, defaultAgentId)
          : agentId,
      ),
    archiveVisibility: (key) => host.sessionDataContext?.sessions.archiveVisibility(key),
  });
  const { childSessionRowsByParent, isSessionHidden, isChildSessionVisible, rows } = visibility;
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const sessionRowsByKey = collectSidebarSessionRowsByKey({
    rows,
    childRowsByParent: childSessionRowsByParent,
  });
  // The agent's anchor session is an ordinary row. Only its internal key stays
  // authoritative for root-parent resolution and child placement.
  const canonicalMainKeys = agentIds.map((agentId) => host.selectedAgentMainSessionKey(agentId));
  const rootRows =
    !grouped && selected === routeAgentId && selected === loadedAgentId
      ? navigationState.visibleSessionRows.flatMap((session) => {
          const row = rowsByKey.get(session.key);
          return row ? [row] : [];
        })
      : filterVisibleSessionRows(rows.filter(inScope), visibilityOptions).toSorted(compareSessions);
  const lineageAgentId = normalizeAgentId(
    parseAgentSessionKey(lineageRoot?.key ?? "")?.agentId ?? "",
  );
  // Adopted catalog keys render as live rows inside the Coding catalog;
  // re-inserting one here would show the selected session twice.
  const selectedFallback = navigationState.visibleSessionRows.find(
    (session) =>
      (grouped ? inScope(session) : selected === routeAgentId || lineageAgentId === selected) &&
      session.key === navigationState.activeRowKey &&
      !isSessionHidden(session) &&
      !adopted.has(session.key),
  );
  const mainSessionKeys = new Set(canonicalMainKeys);
  const scopedRootRows = [...rootRows];
  const lineageRouteAgentId = normalizeAgentId(
    parseAgentSessionKey(navigationState.routeSessionKey)?.agentId ?? "",
  );
  if (
    lineageRoot &&
    !isSessionHidden(lineageRoot) &&
    (areUiSessionKeysEquivalent(lineageRoot.key, navigationState.routeSessionKey) ||
      sessionMatchesArchivedFilter(lineageRoot, host.sessionsStatusFilter)) &&
    (grouped
      ? inScope(lineageRoot)
      : lineageAgentId === selected || lineageRouteAgentId === selected) &&
    !adopted.has(lineageRoot.key) &&
    !scopedRootRows.some((row) => row.key === lineageRoot.key)
  ) {
    scopedRootRows.push(lineageRoot);
  }
  // The shared window includes archives; supplemental child loads must obey
  // the same status and Gateway-owned involvement membership as group roots.
  const visibleRowsByKey = new Map(
    [...sessionRowsByKey].filter(
      ([key, row]) =>
        !grouped ||
        (sessionMatchesArchivedFilter(row, host.sessionsStatusFilter) &&
          (!host.sessionInvolvingMeFilterActive || rowsByKey.has(key))),
    ),
  );
  if (grouped) {
    // Keep the existing current-route/lineage exceptions independently of the
    // bounded shared window and its ordinary status-filtered members.
    for (const row of [...scopedRootRows, ...(selectedFallback ? [selectedFallback] : [])]) {
      visibleRowsByKey.set(row.key, row);
    }
    for (const [key, row] of visibleRowsByKey) {
      const childSessions = row.childSessions?.filter(
        (childKey) =>
          visibleRowsByKey.has(childKey) ||
          (!host.sessionInvolvingMeFilterActive && !sessionRowsByKey.has(childKey)),
      );
      if (childSessions && childSessions.length !== row.childSessions?.length) {
        visibleRowsByKey.set(key, { ...row, childSessions });
      }
    }
  }
  const currentRootKeys = new Set(
    [
      ...rowsByKey.keys(),
      ...scopedRootRows.map((row) => row.key),
      ...(selectedFallback ? [selectedFallback.key] : []),
      ...(lineageRoot &&
      areUiSessionKeysEquivalent(lineageRoot.key, navigationState.routeSessionKey)
        ? [lineageRoot.key]
        : []),
    ].map(normalizeDefaultMainSessionAliasForUi),
  );
  const childKeysByParent = collectSidebarSessionChildKeys(visibleRowsByKey, mainSessionKeys);
  // Detail caches supplement the current forest, including parent-owned links,
  // rather than every Home/category root previously visited in chip mode.
  const reachableKeys = new Set(currentRootKeys);
  for (const key of reachableKeys) {
    for (const child of childKeysByParent.get(key) ?? []) {
      reachableKeys.add(normalizeDefaultMainSessionAliasForUi(child));
    }
  }
  const sessionCandidateRows = [...visibleRowsByKey.values()].filter(
    (row) =>
      inScope(row) &&
      (!grouped || reachableKeys.has(normalizeDefaultMainSessionAliasForUi(row.key))),
  );
  const categorizedChildRows = collectCategorizedChildRootRows({
    rows: sessionCandidateRows,
    scopedRoots: scopedRootRows,
    visibilityOptions,
  });
  scopedRootRows.push(...categorizedChildRows);
  const scopedRootKeys = new Set(scopedRootRows.map((row) => row.key));
  const promotedRows = collectPromotedMainChildRows({
    rows: sessionCandidateRows,
    childKeysByParent,
    archivedFilter: host.sessionsStatusFilter,
    mainSessionKeys,
    scopedRootKeys,
    showCron: host.sessionsShowCron,
    showSystem: host.sessionsShowSystem,
  });
  for (const row of promotedRows) {
    if (!scopedRootKeys.has(row.key)) {
      scopedRootKeys.add(row.key);
      scopedRootRows.push(row);
    }
  }
  const orderedRootRows =
    promotedRows.length > 0 || categorizedChildRows.length > 0
      ? scopedRootRows.toSorted(compareSessions)
      : scopedRootRows;
  // `adopted` holds only catalog-bound keys (adoptedCatalogSessionKeys), not
  // fetched child rows: a catalog-adopted promoted child intentionally
  // renders as its live row inside the Coding catalog, never as a thread.
  const promotedKeys = new Set(promotedRows.map((row) => row.key));
  const projected = projectSessionTree({
    mainSessionKeys,
    // Promoted anchor children already render as roots; never nest them twice.
    excludedChildKeys: promotedKeys,
    forcedRootKeys: promotedKeys,
    roots: orderedRootRows.filter(
      (row) => !adopted.has(row.key) && (!grouped || visibleRowsByKey.has(row.key)),
    ),
    rowsByKey: visibleRowsByKey,
    loadingChildKeys: host.sessionData.loadingChildSessionKeys,
    isChildSessionVisible,
    resolveAttention,
    toSidebarSession: navigationState.toSidebarSession,
  });
  if (
    selectedFallback &&
    !isSubagentSessionKey(selectedFallback.key) &&
    (!grouped || visibleRowsByKey.has(selectedFallback.key)) &&
    !findSidebarSessionInTree(projected, (row) => row.key === selectedFallback.key)
  ) {
    projected.unshift(navigationState.toSidebarSession(selectedFallback));
  }
  return projected;
}
