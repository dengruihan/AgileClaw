// Local structural result keeps this package independent of core session types.
export type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: Record<string, unknown>;
  /** Worktrees preserved while applying the patch (parent and hidden children). */
  preservedWorktrees?: import("./schema/sessions-delete.js").PreservedSessionWorktree[];
  resolved?: {
    modelProvider?: string;
    model?: string;
    agentRuntime?: import("./schema/agents-models-skills.js").GatewayAgentRuntime;
    runtimeSelectionLocked?: boolean;
    contextWindow?: string;
    contextWindows?: Array<{ id: string; label: string; contextWindow: number }>;
    thinkingLevel?: string;
    thinkingLevels?: Array<{ id: string; label: string }>;
  };
};
