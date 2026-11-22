/**
 * Frozen side-conversation snapshot projection.
 *
 * A side conversation starts from one structured snapshot of its parent session
 * and never syncs again. This owner projects the parent's active branch into the
 * child transcript rows: complete tool rounds, text and reasoning prefixes, and a
 * trailing model-only boundary. The projection is pure and byte-deterministic so
 * a retried creation reproduces the same transcript.
 *
 * Rules (see the M199 implementation map):
 * - A tool round is "complete" only when every tool call occurrence has a later,
 *   distinct result occurrence. Async calls are included: the provider may keep
 *   generating, but the frozen snapshot needs the settled result. Incomplete
 *   rounds and their orphan results are dropped whole.
 * - Assistant turns that ended `aborted` or `error` are incomplete; they and
 *   their tool results are dropped.
 * - Reasoning becomes plain text preceded by a fixed marker. Provider replay
 *   signatures are never copied or invented; redacted reasoning without visible
 *   text is dropped rather than reconstructed.
 * - Every copied message (user, assistant, tool result, shell execution) is
 *   display-hidden (`display: false`) but stays in model context:
 *   `excludeFromContext` is never set.
 * - Copied rows form one linear visible chain: parent pointers are rebuilt in
 *   copied order and side-append markers are not carried over.
 * - The boundary row is a model-only custom message; the UI hides it.
 */
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ForkSessionFromParentTranscriptParams,
  ParentForkedSessionTranscript,
  TranscriptEvent,
} from "./session-accessor.types.js";

/** Version of the projection rules; recorded on the child entry and the boundary row. */
const SIDE_CONVERSATION_SNAPSHOT_PROJECTION_VERSION = 1;

/**
 * Model-only custom message carrying the frozen-snapshot boundary.
 *
 * This is deliberately not `openclaw.runtime-context`: that carrier type is
 * retired from historical replay once a turn settles, which would erase an
 * immutable snapshot boundary after the side conversation's first answer.
 */
const SIDE_CONVERSATION_SNAPSHOT_CUSTOM_TYPE = "openclaw.side-conversation-snapshot";

/** Stable id for the trailing boundary row inside a fresh child transcript. */
const SIDE_CONVERSATION_SNAPSHOT_BOUNDARY_ENTRY_ID = "side-conversation-snapshot-boundary";

/** Deterministic fallback when no copied entry can supply a boundary timestamp. */
const EMPTY_SNAPSHOT_TIMESTAMP = new Date(0).toISOString();

/** Fixed lead-in for a copied reasoning prefix; never a provider thinking signature. */
const REASONING_SNAPSHOT_PREFIX = "Earlier reasoning snapshot (reference only):\n";

/** Source facts and drop counts recorded on the child session entry. */
export type SideConversationSnapshotFacts = {
  sourceSessionKey: string;
  sourceSessionId: string;
  sourceLeafEntryId: string | null;
  projectionVersion: number;
  retainedMessages: number;
  droppedIncompleteToolRounds: number;
  droppedIncompleteAssistantMessages: number;
  droppedOrphanToolResults: number;
  droppedContextExcludedMessages: number;
  droppedNonMessageEntries: number;
  droppedCustomMessages: number;
};

/** One frozen child transcript: projected messages followed by the boundary row. */
export type SideConversationSnapshotProjection = {
  facts: SideConversationSnapshotFacts;
  events: TranscriptEvent[];
};

/** Details on the boundary row; mirrors the entry facts for transcript-only readers. */
type SideConversationSnapshotBoundaryDetails = {
  source: "openclaw-side-conversation-snapshot";
  snapshot: SideConversationSnapshotFacts;
};

/** Hidden custom row that tells the model this history is immutable reference material. */
type SideConversationSnapshotBoundaryEntry = {
  type: "custom_message";
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  content: string;
  display: false;
  details: SideConversationSnapshotBoundaryDetails;
};

/** Parent-fork inputs plus the projection version a caller wants recorded. */
export type SideConversationForkTranscriptParams = ForkSessionFromParentTranscriptParams & {
  projectionVersion?: number;
};

/** One prepared frozen side-conversation transcript, ready for the creation owner. */
export type SideConversationForkTranscriptResult =
  | {
      status: "prepared";
      transcript: ParentForkedSessionTranscript;
      events: TranscriptEvent[];
      snapshot: SideConversationSnapshotFacts;
    }
  | {
      status: "snapshot-too-large";
      maxTokens: number;
      snapshotTokens: number;
      message: string;
    }
  | { status: "missing-parent" }
  | { status: "failed" };

/** Rendered boundary text; a pure function of the recorded facts. */
function renderSideConversationSnapshotBoundaryText(facts: SideConversationSnapshotFacts): string {
  return [
    `This conversation is a frozen side-conversation snapshot of parent session ${facts.sourceSessionKey} (session ${facts.sourceSessionId}, leaf ${facts.sourceLeafEntryId ?? "none"}).`,
    "The copied messages above are reference material captured at creation time. They never update again, and nothing you do here is written back to the parent session.",
    "Do not continue, resume, or take over the parent session's task. Treat the copied messages as prior evidence, not as work you must finish.",
    "Only change the worktree or workspace when the operator explicitly asks you to in this side conversation.",
    `Snapshot projection version ${facts.projectionVersion}: retained ${facts.retainedMessages} messages and dropped ${facts.droppedIncompleteToolRounds} incomplete tool rounds, ${facts.droppedIncompleteAssistantMessages} incomplete assistant messages, ${facts.droppedOrphanToolResults} orphan tool results, ${facts.droppedContextExcludedMessages} context-excluded messages, ${facts.droppedNonMessageEntries} non-message entries, and ${facts.droppedCustomMessages} custom messages.`,
  ].join("\n\n");
}

type MessageRecord = Record<string, unknown>;

type ParsedMessageEntry = {
  entry: Record<string, unknown>;
  id: string;
  message: MessageRecord;
};

type CopiedContentBlock = Record<string, unknown>;

type KeptMessage = {
  id: string;
  timestamp: string;
  message: Record<string, unknown>;
};

function parseMessageEntry(entry: unknown): ParsedMessageEntry | undefined {
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
    return undefined;
  }
  const id = entry.id;
  if (typeof id !== "string" || !id.trim()) {
    return undefined;
  }
  return { entry, id, message: entry.message };
}

function readMessageTimestampMs(message: MessageRecord, entry: Record<string, unknown>): number {
  const timestamp = message.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return timestamp;
  }
  const parsed = typeof timestamp === "string" ? parseDateStringTimestampMs(timestamp) : undefined;
  if (parsed !== undefined) {
    return parsed;
  }
  const entryTimestamp = entry.timestamp;
  if (typeof entryTimestamp === "number" && Number.isFinite(entryTimestamp)) {
    return entryTimestamp;
  }
  return (
    (typeof entryTimestamp === "string" ? parseDateStringTimestampMs(entryTimestamp) : undefined) ??
    0
  );
}

/** Keep a persisted timestamp string, or derive one from the message clock. */
function resolveEntryTimestamp(message: MessageRecord, entry: Record<string, unknown>): string {
  const timestamp = entry.timestamp;
  if (typeof timestamp === "string" && timestamp.trim()) {
    return timestamp;
  }
  return new Date(readMessageTimestampMs(message, entry)).toISOString();
}

function readToolCallIds(message: MessageRecord): string[] {
  const content = message.content;
  const ids: string[] = [];
  if (!Array.isArray(content)) {
    return ids;
  }
  for (const block of content) {
    if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string") {
      ids.push(block.id);
    }
  }
  return ids;
}

function readToolResultCallId(message: MessageRecord): string | undefined {
  return typeof message.toolCallId === "string" && message.toolCallId.trim()
    ? message.toolCallId
    : undefined;
}

function projectTextBlock(block: Record<string, unknown>): CopiedContentBlock[] {
  return typeof block.text === "string" ? [{ type: "text", text: block.text }] : [];
}

function projectImageBlock(block: Record<string, unknown>): CopiedContentBlock[] {
  return typeof block.data === "string" && typeof block.mimeType === "string"
    ? [{ type: "image", data: block.data, mimeType: block.mimeType }]
    : [];
}

function projectAssistantBlock(block: unknown): CopiedContentBlock[] {
  if (!isRecord(block)) {
    return [];
  }
  switch (block.type) {
    case "text":
      return projectTextBlock(block);
    case "thinking": {
      // Reasoning is preserved as ordinary text: a provider-native signed
      // thinking block cannot be replayed under another model or session.
      const thinking = typeof block.thinking === "string" ? block.thinking : "";
      return thinking.trim()
        ? [{ type: "text", text: `${REASONING_SNAPSHOT_PREFIX}${thinking}` }]
        : [];
    }
    case "toolCall": {
      if (
        typeof block.id !== "string" ||
        typeof block.name !== "string" ||
        !isRecord(block.arguments)
      ) {
        return [];
      }
      return [
        {
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: structuredClone(block.arguments),
          ...(block.async === true ? { async: true } : {}),
          ...(block.executionMode === "sequential" || block.executionMode === "parallel"
            ? { executionMode: block.executionMode }
            : {}),
        },
      ];
    }
    default:
      return [];
  }
}

function projectUserContent(content: unknown): string | CopiedContentBlock[] {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.flatMap((block): CopiedContentBlock[] => {
    if (!isRecord(block)) {
      return [];
    }
    switch (block.type) {
      case "text":
        return projectTextBlock(block);
      case "image":
        return projectImageBlock(block);
      default:
        return [structuredClone(block)];
    }
  });
}

function projectToolResultContent(content: unknown): CopiedContentBlock[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block): CopiedContentBlock[] => {
    if (!isRecord(block)) {
      return [];
    }
    switch (block.type) {
      case "text":
        return projectTextBlock(block);
      case "image":
        return projectImageBlock(block);
      default:
        return [structuredClone(block)];
    }
  });
}

function copyString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function copyRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? structuredClone(value) : undefined;
}

function projectUserMessage(entry: ParsedMessageEntry): Record<string, unknown> {
  const { message } = entry;
  return {
    role: "user",
    content: projectUserContent(message.content),
    display: false,
    timestamp: readMessageTimestampMs(message, entry.entry),
  };
}

function projectAssistantMessage(entry: ParsedMessageEntry): Record<string, unknown> {
  const { message } = entry;
  const content = Array.isArray(message.content)
    ? message.content.flatMap(projectAssistantBlock)
    : typeof message.content === "string"
      ? message.content
      : [];
  const api = copyString(message.api);
  const provider = copyString(message.provider);
  const model = copyString(message.model);
  const responseModel = copyString(message.responseModel);
  const stopReason = copyString(message.stopReason);
  const usage = copyRecord(message.usage);
  return {
    role: "assistant",
    content,
    display: false,
    ...(api ? { api } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(responseModel ? { responseModel } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(typeof message.endTurn === "boolean" ? { endTurn: message.endTurn } : {}),
    ...(usage ? { usage } : {}),
    timestamp: readMessageTimestampMs(message, entry.entry),
  };
}

function projectToolResultMessage(entry: ParsedMessageEntry): Record<string, unknown> {
  const { message } = entry;
  const toolCallId = copyString(message.toolCallId);
  const toolName = copyString(message.toolName);
  const details = copyRecord(message.details);
  return {
    role: "toolResult",
    content: projectToolResultContent(message.content),
    display: false,
    isError: message.isError === true,
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(details ? { details } : {}),
    timestamp: readMessageTimestampMs(message, entry.entry),
  };
}

function projectBashExecutionMessage(entry: ParsedMessageEntry): Record<string, unknown> {
  const { message } = entry;
  const command = copyString(message.command);
  const output = copyString(message.output);
  const fullOutputPath = copyString(message.fullOutputPath);
  const exitCode = message.exitCode;
  return {
    role: "bashExecution",
    command: command ?? "",
    output: output ?? "",
    display: false,
    ...(typeof exitCode === "number" ? { exitCode } : {}),
    cancelled: message.cancelled === true,
    truncated: message.truncated === true,
    ...(fullOutputPath ? { fullOutputPath } : {}),
    timestamp: readMessageTimestampMs(message, entry.entry),
  };
}

/**
 * Match tool calls to results by occurrence across the whole branch.
 *
 * A result may land after a continuation assistant turn (an async call let the
 * provider keep generating), so adjacency cannot decide completeness. Each call
 * occurrence claims the earliest unclaimed later result with its id; a call with
 * no such result leaves its assistant turn incomplete.
 */
function matchToolRounds(candidates: readonly ParsedMessageEntry[]): {
  retainedAssistants: Set<number>;
  retainedResults: Set<number>;
  droppedIncompleteToolRounds: number;
  droppedOrphanToolResults: number;
} {
  const resultsByCallId = new Map<string, number[]>();
  for (const [index, parsed] of candidates.entries()) {
    if (parsed.message.role !== "toolResult") {
      continue;
    }
    const toolCallId = readToolResultCallId(parsed.message);
    if (!toolCallId) {
      continue;
    }
    const indexes = resultsByCallId.get(toolCallId);
    if (indexes) {
      indexes.push(index);
    } else {
      resultsByCallId.set(toolCallId, [index]);
    }
  }

  const retainedAssistants = new Set<number>();
  const retainedResults = new Set<number>();
  let droppedIncompleteToolRounds = 0;

  for (const [index, parsed] of candidates.entries()) {
    if (parsed.message.role !== "assistant") {
      continue;
    }
    if (parsed.message.stopReason === "aborted" || parsed.message.stopReason === "error") {
      continue;
    }
    const callIds = readToolCallIds(parsed.message);
    const matched: number[] = [];
    let complete = true;
    for (const callId of callIds) {
      const resultIndex = claimResultAfter(resultsByCallId, callId, index);
      if (resultIndex === undefined) {
        complete = false;
        continue;
      }
      matched.push(resultIndex);
    }
    if (!complete) {
      // The turn keeps its claimed results out of play: the earliest call owns
      // the earliest result, and a dropped turn's results are orphaned.
      droppedIncompleteToolRounds += 1;
      continue;
    }
    retainedAssistants.add(index);
    for (const resultIndex of matched) {
      retainedResults.add(resultIndex);
    }
  }

  let droppedOrphanToolResults = 0;
  for (const [index, parsed] of candidates.entries()) {
    if (parsed.message.role === "toolResult" && !retainedResults.has(index)) {
      droppedOrphanToolResults += 1;
    }
  }

  return {
    retainedAssistants,
    retainedResults,
    droppedIncompleteToolRounds,
    droppedOrphanToolResults,
  };
}

/** Claim the first unclaimed result for this call that appears after the call's turn. */
function claimResultAfter(
  resultsByCallId: Map<string, number[]>,
  toolCallId: string,
  assistantIndex: number,
): number | undefined {
  const indexes = resultsByCallId.get(toolCallId);
  if (!indexes) {
    return undefined;
  }
  for (const [position, resultIndex] of indexes.entries()) {
    if (resultIndex > assistantIndex) {
      indexes.splice(position, 1);
      return resultIndex;
    }
  }
  return undefined;
}

/**
 * Project a parent active branch into frozen side-conversation child rows.
 *
 * Only `message` entries are candidates. Control rows (compaction, model or
 * reasoning changes, labels, leaf markers) count as dropped non-message entries,
 * and both `custom_message` rows and `role: "custom"` messages count as dropped
 * custom rows: the snapshot is conversation content, not a replay of parent
 * model wiring or application activity.
 */
export function projectSideConversationSnapshot(params: {
  branchEntries: readonly TranscriptEvent[];
  sourceSessionKey: string;
  sourceSessionId: string;
  sourceLeafEntryId: string | null;
  projectionVersion?: number;
}): SideConversationSnapshotProjection {
  const candidates: ParsedMessageEntry[] = [];
  let droppedNonMessageEntries = 0;
  let droppedContextExcludedMessages = 0;
  let droppedCustomMessages = 0;
  for (const entry of params.branchEntries) {
    // `custom_message` is the canonical persisted shape for application content;
    // it is not model conversation, but it is still a custom row.
    if (isRecord(entry) && entry.type === "custom_message") {
      droppedCustomMessages += 1;
      continue;
    }
    const parsed = parseMessageEntry(entry);
    if (!parsed) {
      droppedNonMessageEntries += 1;
      continue;
    }
    if (parsed.message.excludeFromContext === true) {
      droppedContextExcludedMessages += 1;
      continue;
    }
    candidates.push(parsed);
  }

  const {
    retainedAssistants,
    retainedResults,
    droppedIncompleteToolRounds,
    droppedOrphanToolResults,
  } = matchToolRounds(candidates);
  const kept: KeptMessage[] = [];
  let droppedIncompleteAssistantMessages = 0;

  for (const [index, parsed] of candidates.entries()) {
    const role = parsed.message.role;

    if (role === "assistant") {
      // Aborted and error turns are incomplete by definition: their text and
      // reasoning stopped mid-stream, and any tool call has no settled result.
      if (parsed.message.stopReason === "aborted" || parsed.message.stopReason === "error") {
        droppedIncompleteAssistantMessages += 1;
        continue;
      }
      if (!retainedAssistants.has(index)) {
        continue;
      }
      kept.push({
        id: parsed.id,
        timestamp: resolveEntryTimestamp(parsed.message, parsed.entry),
        message: projectAssistantMessage(parsed),
      });
      continue;
    }

    if (role === "toolResult") {
      // Results whose assistant round was dropped never reach a retained call.
      if (!retainedResults.has(index)) {
        continue;
      }
      kept.push({
        id: parsed.id,
        timestamp: resolveEntryTimestamp(parsed.message, parsed.entry),
        message: projectToolResultMessage(parsed),
      });
      continue;
    }

    if (role === "user") {
      kept.push({
        id: parsed.id,
        timestamp: resolveEntryTimestamp(parsed.message, parsed.entry),
        message: projectUserMessage(parsed),
      });
      continue;
    }

    if (role === "bashExecution") {
      kept.push({
        id: parsed.id,
        timestamp: resolveEntryTimestamp(parsed.message, parsed.entry),
        message: projectBashExecutionMessage(parsed),
      });
      continue;
    }

    droppedCustomMessages += 1;
  }

  const facts: SideConversationSnapshotFacts = {
    sourceSessionKey: params.sourceSessionKey,
    sourceSessionId: params.sourceSessionId,
    sourceLeafEntryId: params.sourceLeafEntryId,
    projectionVersion: params.projectionVersion ?? SIDE_CONVERSATION_SNAPSHOT_PROJECTION_VERSION,
    retainedMessages: kept.length,
    droppedIncompleteToolRounds,
    droppedIncompleteAssistantMessages,
    droppedOrphanToolResults,
    droppedContextExcludedMessages,
    droppedNonMessageEntries,
    droppedCustomMessages,
  };

  const events: TranscriptEvent[] = [];
  let parentId: string | null = null;
  for (const item of kept) {
    // Rebuild one linear chain so dropped rows leave no dangling parent pointer.
    events.push({
      type: "message",
      id: item.id,
      parentId,
      timestamp: item.timestamp,
      message: item.message,
    });
    parentId = item.id;
  }
  events.push(
    buildSideConversationSnapshotBoundaryEntry({
      facts,
      parentId,
      timestamp: kept.at(-1)?.timestamp ?? EMPTY_SNAPSHOT_TIMESTAMP,
    }),
  );
  return { facts, events };
}

/** Fixed-shape boundary row: hidden from UI, replayed as model-only reference context. */
function buildSideConversationSnapshotBoundaryEntry(params: {
  facts: SideConversationSnapshotFacts;
  parentId: string | null;
  timestamp?: string;
}): SideConversationSnapshotBoundaryEntry {
  return {
    type: "custom_message",
    id: SIDE_CONVERSATION_SNAPSHOT_BOUNDARY_ENTRY_ID,
    parentId: params.parentId,
    timestamp: params.timestamp ?? EMPTY_SNAPSHOT_TIMESTAMP,
    customType: SIDE_CONVERSATION_SNAPSHOT_CUSTOM_TYPE,
    content: renderSideConversationSnapshotBoundaryText(params.facts),
    display: false,
    details: {
      source: "openclaw-side-conversation-snapshot",
      snapshot: params.facts,
    },
  };
}
