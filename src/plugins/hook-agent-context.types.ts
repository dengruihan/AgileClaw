import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { PluginHookChannelContext } from "./hook-channel-context.types.js";
import type { MemoryAudience } from "./memory-provider-types.js";

type PluginHookContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";

export type PluginHookContextWindow = {
  /** Resolved effective context-token budget after model/config/agent caps. */
  contextTokenBudget?: number;
  /** Source that supplied the resolved context-token budget. */
  contextWindowSource?: PluginHookContextWindowSource;
  /** Native/configured reference window when a lower cap wins. */
  contextWindowReferenceTokens?: number;
};

export type PluginHookToolAuthority = {
  /** Opaque host fingerprint for the exact turn, route, policy, and active tool surface. */
  readonly fingerprint: string;
  /** Checks whether the finalized turn surface contains this exact tool. */
  allows(toolName: string): boolean;
  /** Rejects retained or timed-out capabilities after the host dispatch closes. */
  assertActive(): void;
};

/** Bounded material contribution from a background source bound to the current admitted input. */
export type TurnContextContributionInput = {
  /** Source-stable identity; the host rejects duplicate ids on the same input. */
  id: string;
  /** Bounded, source-attributed material text. The host enforces a hard length cap. */
  text: string;
};

export type TurnContextSourceScope = {
  /** Aborts when the owning input, run, or plugin generation ends. */
  signal: AbortSignal;
  /** Rejects after the owning input, turn authority, or memory audience is no longer current. */
  assertCurrent(): void;
  publish(
    contribution: TurnContextContributionInput,
  ): { status: "queued"; id: string } | { status: "duplicate" | "closed" | "budget-exceeded" };
};

export type TurnContextSource = {
  /**
   * Synchronous, bounded observation of projected assistant text. Append events carry
   * the new delta; replace events carry the full projected snapshot. Never await here.
   */
  onAssistantText?(event: { text: string; kind: "append" | "replace" }): void;
  /** Called at most once at the natural-end gate; start remaining bounded work and settle in-flight work before the deadline. */
  flush(deadlineAtMs: number): Promise<void>;
  /** Clear timers, cancel work, and settle owned tasks; safe to call repeatedly. */
  dispose(): Promise<void>;
};

export type TurnContextAttachOptions = {
  /** Stable source key; one attach per key per admitted input. */
  key: string;
  /** Tools this source needs throughout its lifetime, checked against the live surface. */
  requiredTools?: readonly string[];
  /** Additional source lifetime; abort closes the source and rejects its queued material. */
  signal?: AbortSignal;
  /** Source owner authority, rechecked when publishing, installing, and submitting material. */
  assertCurrent?: () => void;
  /** Extra natural-end wait budget; host-clamped to [0, 10000] ms. */
  terminalWaitMs?: number;
  /** Same-turn continuations this source may request; host-clamped to [0, 1]. */
  maxFinalContinuations?: number;
};

/**
 * Host-owned background material contribution surface. Present only on the builtin
 * runtime's authorized prompt-build phase; attach is synchronous and cheap.
 */
export type TurnContextContributionsHost = {
  attach(
    options: TurnContextAttachOptions,
    factory: (scope: TurnContextSourceScope) => TurnContextSource,
  ): { status: "attached" | "already-attached" | "unsupported" };
};

export type PluginHookAgentContext = PluginHookContextWindow & {
  runId?: string;
  jobId?: string;
  trace?: DiagnosticTraceContext;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  /** Host-resolved memory partition for this turn. */
  memoryAudience?: MemoryAudience;
  /** Rejects the audience after any captured session incarnation changes. */
  assertMemoryAudienceCurrent?: () => void;
  /** Whether this turn's tool/runtime surface is sandboxed. */
  sandboxed?: boolean;
  workspaceDir?: string;
  /** Run-prepared repository identities; empty when the turn is outside a repository. */
  activeProjectKeys?: string[];
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  /** Channel/plugin id for channel-originated runs, e.g. `discord`. */
  channel?: string;
  /** Channel account used by the agent when multiple accounts are configured. */
  accountId?: string;
  /** Conversation target id for channel-originated runs. Mirrors `channelId` for compatibility. */
  chatId?: string;
  /** Sender identity for channel-originated runs when available. */
  senderId?: string;
  trigger?: string;
  channelId?: string;
  /** Typed origin of the turn's user-role input when supplied by the producer. */
  inputProvenance?: InputProvenance;
  /** @deprecated Use `channelContext.sender` for channel-specific identities. */
  senderExternalId?: string;
  /** Channel-owned sender/chat details. Plugins may augment the nested interfaces. */
  channelContext?: PluginHookChannelContext;
  /** Present only for post-policy prompt enrichment hooks that requested tool authority. */
  toolAuthority?: PluginHookToolAuthority;
  /**
   * Background material contribution surface bound to the current admitted input.
   * Present only in the builtin runtime's authorized prompt-build phase.
   */
  turnContextContributions?: TurnContextContributionsHost;
  /** Checks this prompt hook handler's result-acceptance lifetime. */
  readonly hookInvocation?: Readonly<{ assertActive(): void }>;
};
