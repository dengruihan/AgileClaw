import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentIdentityResult,
  AgentFileEntry,
  AgentsFilesGetResult,
  AgentsFilesListResult,
  AgentsFilesSetResult,
} from "../../api/types.ts";
import type { AgentIdentityCapability } from "../../lib/agents/identity.ts";
import type { AgentCapability } from "../../lib/agents/index.ts";
import { formatUiError } from "../../lib/format-error.ts";

type AgentFileVersion = { hash: string } | { missing: true };

export const IDENTITY_FILE_NAME = "IDENTITY.md";

/**
 * The gateway list omits IDENTITY.md because agents.update rewrites it through
 * a field merge; the files panel still offers it as a direct editor, so its tab
 * is synthesized until a confirmed read or write supplies the real entry.
 */
export function withIdentityFileEntry(list: AgentsFilesListResult | null): AgentFileEntry[] {
  const files = list?.files;
  if (!list || !files) {
    return [];
  }
  if (files.some((file) => file.name === IDENTITY_FILE_NAME)) {
    return files;
  }
  const entry: AgentFileEntry = {
    name: IDENTITY_FILE_NAME,
    path: `${list.workspace.replace(/\/+$/, "")}/${IDENTITY_FILE_NAME}`,
    missing: false,
  };
  const index = files.findIndex((file) => file.name === "USER.md" || file.name === "SOUL.md");
  const insertAt = index === -1 ? files.length : index + 1;
  return [...files.slice(0, insertAt), entry, ...files.slice(insertAt)];
}

/**
 * IDENTITY.md editing waits while the persisted avatar is still embedded
 * Base64: the file is megabytes of encoded image and the identity form's next
 * save rewrites it. The editor offers migration guidance instead.
 */
export function isIdentityFileEditorHeld(
  name: string,
  identity: Pick<AgentIdentityResult, "avatarStatus"> | null | undefined,
): boolean {
  return name === IDENTITY_FILE_NAME && identity?.avatarStatus === "data";
}

export type AgentFilesState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  requestGeneration: number;
  agents: Pick<AgentCapability, "recordFile" | "refreshList">;
  agentIdentity: AgentIdentityCapability;
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFileContents: Record<string, string>;
  agentFileBaseVersions: Record<string, AgentFileVersion>;
  agentFileVersions: Record<string, AgentFileVersion>;
  agentFileConflict: string | null;
  agentFileDrafts: Record<string, string>;
  agentFileSaving: boolean;
  agentFileWriteRevisions: Map<string, number>;
};

export type AgentFilesViewState = Pick<
  AgentFilesState,
  | "agentFilesLoading"
  | "agentFilesError"
  | "agentFileContents"
  | "agentFileDrafts"
  | "agentFileSaving"
  | "agentFileConflict"
> & {
  agentFilesList: AgentsFilesListResult | null;
  agentFileActive: string | null;
};

/** Retire the selected agent's file cache and drafts with its request generation. */
export function resetAgentFiles(state: AgentFilesState & AgentFilesViewState): void {
  state.agentFilesList = null;
  state.agentFilesError = null;
  state.agentFileActive = null;
  state.agentFileContents = {};
  state.agentFileBaseVersions = {};
  state.agentFileVersions = {};
  state.agentFileConflict = null;
  state.agentFileDrafts = {};
  state.agentFileWriteRevisions.clear();
  state.agentFilesLoading = false;
  state.agentFileSaving = false;
}

export function hasAgentFileContent(
  state: Pick<AgentFilesState, "agentFileContents" | "agentFileDrafts">,
  name: string,
): boolean {
  return Object.hasOwn(state.agentFileContents, name) || Object.hasOwn(state.agentFileDrafts, name);
}

export type RetainedAgentFileDrafts = {
  drafts: Record<string, string>;
  versions: Record<string, AgentFileVersion>;
  active: string | null;
  conflict: string | null;
};

export function retainAgentFileDrafts(
  state: AgentFilesState & { agentFileActive: string | null },
): RetainedAgentFileDrafts | null {
  const entries = Object.entries(state.agentFileDrafts).filter(
    ([name, draft]) => draft !== state.agentFileContents[name] || state.agentFileConflict === name,
  );
  if (entries.length === 0) {
    return null;
  }
  return {
    drafts: Object.fromEntries(entries),
    versions: Object.fromEntries(
      entries.flatMap(([name]) =>
        state.agentFileVersions[name] === undefined ? [] : [[name, state.agentFileVersions[name]]],
      ),
    ),
    active: state.agentFileActive,
    conflict: state.agentFileConflict,
  };
}

function withFileVersion(
  versions: Record<string, AgentFileVersion>,
  name: string,
  version: AgentFileVersion | undefined,
): Record<string, AgentFileVersion> {
  const next = { ...versions };
  if (version === undefined) {
    delete next[name];
  } else {
    next[name] = version;
  }
  return next;
}

async function requestAgentFile(
  state: AgentFilesState,
  agentId: string,
  name: string,
  operation:
    | { kind: "read"; force?: boolean; resolution?: "draft" | "hash" }
    | { kind: "write"; content: string },
): Promise<boolean> {
  const saving = operation.kind === "write";
  const busy = saving ? "agentFileSaving" : "agentFilesLoading";
  const client = state.client;
  const agents = state.agents;
  if (!client || !state.connected || state[busy] || (saving && !hasAgentFileContent(state, name))) {
    return false;
  }
  if (
    operation.kind === "read" &&
    !operation.force &&
    Object.hasOwn(state.agentFileContents, name)
  ) {
    return true;
  }
  const generation = state.requestGeneration;
  const isConnected = () =>
    state.client === client &&
    state.agents === agents &&
    state.connected &&
    state.requestGeneration === generation;
  const advanceWriteRevision = () => {
    state.agentFileWriteRevisions.set(name, (state.agentFileWriteRevisions.get(name) ?? 0) + 1);
  };
  // Retire reads admitted before a write, and again on settlement for reads
  // admitted during it: a later read request can still return pre-write bytes.
  if (saving) {
    advanceWriteRevision();
  }
  const revision = state.agentFileWriteRevisions.get(name);
  const isCurrent = () =>
    isConnected() && (saving || state.agentFileWriteRevisions.get(name) === revision);
  const version = state.agentFileVersions[name];
  const resolution = operation.kind === "read" ? operation.resolution : undefined;
  state[busy] = true;
  state.agentFilesError = null;
  try {
    const res = await client.request<AgentsFilesGetResult | AgentsFilesSetResult | null>(
      saving ? "agents.files.set" : "agents.files.get",
      {
        agentId,
        name,
        ...(operation.kind === "write"
          ? {
              content: operation.content,
              ...(version &&
                ("hash" in version ? { expectedHash: version.hash } : { expectedMissing: true })),
            }
          : {}),
      },
    );
    if (res?.file && isCurrent()) {
      const content = operation.kind === "write" ? operation.content : (res.file.content ?? "");
      const previousBase = state.agentFileContents[name];
      const currentDraft = state.agentFileDrafts[name];
      const nextVersion: AgentFileVersion | undefined = res.file.missing
        ? { missing: true }
        : res.file.hash
          ? { hash: res.file.hash }
          : undefined;
      state.agentFileContents = { ...state.agentFileContents, [name]: content };
      // Refresh may advance the workspace base while a dirty draft keeps its ancestry.
      state.agentFileBaseVersions = withFileVersion(state.agentFileBaseVersions, name, nextVersion);
      // Reads rebase clean drafts; writes preserve edits made after submission.
      const rebasesDraft =
        resolution === "draft" ||
        !Object.hasOwn(state.agentFileDrafts, name) ||
        currentDraft === content ||
        (!saving && currentDraft === previousBase);
      if (rebasesDraft) {
        state.agentFileDrafts = { ...state.agentFileDrafts, [name]: content };
      }
      if (saving || resolution !== undefined || rebasesDraft) {
        state.agentFileVersions = withFileVersion(state.agentFileVersions, name, nextVersion);
        if (state.agentFileConflict === name) {
          state.agentFileConflict = null;
        }
      }
      state.agentFilesError = null;
      agents.recordFile(res);
      return true;
    }
  } catch (err) {
    if (isCurrent()) {
      state.agentFilesError = formatUiError(err);
      if (isAgentFileConflict(err)) {
        state.agentFileConflict = name;
      }
    }
    return false;
  } finally {
    if (isConnected()) {
      if (saving) {
        advanceWriteRevision();
      }
      state[busy] = false;
    }
  }
  return false;
}

function isAgentFileConflict(err: unknown): boolean {
  return (
    err instanceof GatewayRequestError &&
    isRecord(err.details) &&
    err.details.type === "agent_file_conflict"
  );
}

export function loadAgentFileContent(
  state: AgentFilesState,
  agentId: string,
  name: string,
  opts?: { force?: boolean },
): Promise<boolean> {
  return requestAgentFile(state, agentId, name, { kind: "read", force: opts?.force });
}

export function saveAgentFile(
  state: AgentFilesState,
  agentId: string,
  name: string,
  content: string,
): Promise<boolean> {
  return requestAgentFile(state, agentId, name, { kind: "write", content });
}

export function resetAgentFile(state: AgentFilesState, name: string): void {
  if (!Object.hasOwn(state.agentFileContents, name)) {
    return;
  }
  state.agentFileDrafts = {
    ...state.agentFileDrafts,
    [name]: state.agentFileContents[name] ?? "",
  };
  state.agentFileVersions = withFileVersion(
    state.agentFileVersions,
    name,
    state.agentFileBaseVersions[name],
  );
  if (state.agentFileConflict === name) {
    state.agentFileConflict = null;
    state.agentFilesError = null;
  }
}

export function reloadAgentFile(
  state: AgentFilesState,
  agentId: string,
  name: string,
): Promise<boolean> {
  return requestAgentFile(state, agentId, name, {
    kind: "read",
    force: true,
    resolution: "draft",
  });
}

export async function overwriteAgentFile(
  state: AgentFilesState,
  agentId: string,
  name: string,
  content: string,
): Promise<boolean> {
  const client = state.client;
  const agents = state.agents;
  const generation = state.requestGeneration;
  const rebased = await requestAgentFile(state, agentId, name, {
    kind: "read",
    force: true,
    resolution: "hash",
  });
  // Publishing the read can retire its scope before this continuation dispatches a write.
  if (
    !rebased ||
    !state.connected ||
    state.client !== client ||
    state.agents !== agents ||
    state.requestGeneration !== generation
  ) {
    return false;
  }
  return await requestAgentFile(state, agentId, name, { kind: "write", content });
}

/** Selection-time read for one file. IDENTITY.md waits for the roster identity
    before loading: an unresolved avatar status must not fetch the file while
    it may still embed a Base64 avatar. A failed identity read falls back to a
    normal load rather than silently locking the tab. Selection changes and
    reconnects retire the wait, so a delayed identity cannot read a workspace
    the page no longer shows. */
export async function loadSelectedAgentFile(
  state: AgentFilesState,
  agentId: string,
  name: string,
  opts?: { force?: boolean },
): Promise<boolean> {
  if (name === IDENTITY_FILE_NAME && !state.agentIdentity.get(agentId)) {
    const generation = state.requestGeneration;
    const client = state.client;
    await state.agentIdentity.ensure([agentId]).catch(() => undefined);
    if (state.requestGeneration !== generation || state.client !== client) {
      return false;
    }
  }
  if (isIdentityFileEditorHeld(name, state.agentIdentity.get(agentId))) {
    return false;
  }
  return loadAgentFileContent(state, agentId, name, opts);
}

/** A confirmed IDENTITY.md write changes the parsed identity the overview form
    and sidebar display; drop the shared identity cache and re-read it so both
    entries agree. The capabilities scope themselves to the live connection. */
export async function syncIdentityAfterIdentityFileWrite(
  state: AgentFilesState,
  agentId: string,
): Promise<void> {
  state.agentIdentity.invalidate([agentId]);
  await state.agents.refreshList().catch(() => undefined);
  await state.agentIdentity.ensure([agentId]).catch(() => undefined);
}

/** After a file write settles, run the follow-up its name requires. */
export function settleAgentFileWrite(
  state: AgentFilesState,
  agentId: string,
  name: string,
  saved: boolean,
): void {
  if (saved && name === IDENTITY_FILE_NAME) {
    void syncIdentityAfterIdentityFileWrite(state, agentId);
  }
}

/** The identity form rewrites IDENTITY.md through agents.update; advance the
    direct editor's base so both entrances show the same content. A plain
    forced read keeps a dirty draft and its expectedHash ancestry intact — the
    next save conflicts and the operator resolves it — while clean drafts
    rebase. A held editor keeps its migration guidance instead of pulling
    embedded bytes. Callers run it while their request scope is current. */
export function refreshIdentityFileBase(state: AgentFilesState, agentId: string): void {
  if (
    !Object.hasOwn(state.agentFileContents, IDENTITY_FILE_NAME) ||
    isIdentityFileEditorHeld(IDENTITY_FILE_NAME, state.agentIdentity.get(agentId))
  ) {
    return;
  }
  void loadAgentFileContent(state, agentId, IDENTITY_FILE_NAME, { force: true });
}
