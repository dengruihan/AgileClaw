import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { SessionSystemPromptReport } from "../../../../src/config/sessions/session-system-prompt-report.js";
import type { ToolsEffectiveResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { requestSessionUsage } from "../../lib/sessions/usage.ts";

export type ChatContextUsageDetail = {
  status: "idle" | "loading" | "ready" | "error";
  report: SessionSystemPromptReport | null;
  toolsEffective: ToolsEffectiveResult | null;
  error: string | null;
};

export type ChatContextUsageSession = {
  sessionKey: string;
  agentId?: string;
  sessionId?: string;
  createdAt?: number;
  totalTokens?: number;
};

const IDLE_DETAIL: ChatContextUsageDetail = {
  status: "idle",
  report: null,
  toolsEffective: null,
  error: null,
};

const DAY_MS = 86_400_000;

function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * Lazily loads the context breakdown for the composer's usage hover card.
 * Nothing is fetched until the ring reports hover or focus intent; results
 * stay cached per connection/session and refresh when the context snapshot
 * moves, because the Gateway writes the report alongside totalTokens at run
 * end.
 */
export class ChatContextUsageController implements ReactiveController {
  detail: ChatContextUsageDetail = IDLE_DETAIL;

  #host: ReactiveControllerHost;
  #getContext: () => Pick<ApplicationContext["gateway"], "snapshot" | "connectionRevision">;
  #getSession: () => ChatContextUsageSession | undefined;
  #owner: {
    client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
    revision: number;
    sessionKey: string;
  } | null = null;
  #loadedKey: string | null = null;
  #controller: AbortController | null = null;

  constructor(
    host: ReactiveControllerHost,
    getContext: () => Pick<ApplicationContext["gateway"], "snapshot" | "connectionRevision">,
    getSession: () => ChatContextUsageSession | undefined,
  ) {
    this.#host = host;
    this.#getContext = getContext;
    this.#getSession = getSession;
    host.addController(this);
  }

  /** Hover/focus intent from the ring; loads or refreshes the breakdown. */
  intent(): void {
    const { snapshot, connectionRevision: revision } = this.#getContext();
    const session = this.#getSession();
    if (snapshot.phase !== "connected" || !snapshot.client || !session) {
      return;
    }
    const client = snapshot.client;
    // The report is persisted with the token snapshot, so totalTokens moving
    // invalidates the previous breakdown.
    const key = `${revision}|${session.sessionKey}|${session.totalTokens ?? 0}`;
    if (
      this.#owner?.client === client &&
      this.#loadedKey === key &&
      this.detail.status !== "error"
    ) {
      return;
    }
    this.#controller?.abort();
    const controller = new AbortController();
    const owner = { client, revision, sessionKey: session.sessionKey };
    this.#owner = owner;
    this.#loadedKey = key;
    this.#controller = controller;
    this.#publish({ status: "loading", report: null, toolsEffective: null, error: null });
    const options = { signal: controller.signal };
    // The date window only has to cover the session's own rows; usage
    // aggregation filters sessions by activity date.
    const usagePromise = requestSessionUsage(
      client,
      {
        startDate: localDay((session.createdAt ?? Date.now()) - DAY_MS),
        endDate: localDay(Date.now() + DAY_MS),
        scope: "instance",
        timeZone: "local",
        ...(session.agentId ? { agentId: session.agentId } : {}),
      },
      { key: session.sessionKey, includeContextWeight: true, signal: controller.signal },
    );
    const toolsPromise =
      isGatewayMethodAdvertised(snapshot, "tools.effective") === true
        ? client
            .request<ToolsEffectiveResult>(
              "tools.effective",
              {
                sessionKey: session.sessionKey,
                ...(session.agentId ? { agentId: session.agentId } : {}),
              },
              options,
            )
            .catch(() => null)
        : Promise.resolve(null);
    void Promise.allSettled([usagePromise, toolsPromise]).then(([usage, tools]) => {
      if (this.#owner !== owner || this.#controller !== controller) {
        return;
      }
      this.#controller = null;
      if (usage.status === "rejected") {
        this.#publish({ status: "error", report: null, toolsEffective: null, error: "usage" });
        return;
      }
      const row = usage.value.sessions[0];
      // A key can be re-created by compaction; never show a predecessor's
      // breakdown under the successor's row.
      const live = this.#getSession();
      const superseded =
        row?.sessionId !== undefined &&
        live?.sessionId !== undefined &&
        row.sessionId !== live.sessionId;
      this.#publish({
        status: "ready",
        report: superseded || !row?.contextWeight ? null : row.contextWeight,
        toolsEffective: tools.status === "fulfilled" ? tools.value : null,
        error: null,
      });
    });
  }

  hostUpdate(): void {
    const { snapshot, connectionRevision } = this.#getContext();
    const session = this.#getSession();
    const current =
      snapshot.phase === "connected" &&
      snapshot.client &&
      session &&
      this.#owner?.client === snapshot.client &&
      this.#owner.revision === connectionRevision &&
      this.#owner.sessionKey === session.sessionKey;
    if (!current) {
      this.#reset();
    }
  }

  hostDisconnected(): void {
    this.#reset();
  }

  #reset(): void {
    this.#controller?.abort();
    this.#controller = null;
    this.#owner = null;
    this.#loadedKey = null;
    if (this.detail.status !== "idle") {
      this.#publish(IDLE_DETAIL);
    }
  }

  #publish(detail: ChatContextUsageDetail): void {
    this.detail = detail;
    this.#host.requestUpdate();
  }
}
