import { GatewayRequestError, resolveGatewayErrorDetailCode } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  filterSkillExperiences,
  SKILL_EXPERIENCE_REVISION_CHANGED,
  sortSkillExperiences,
  type SkillExperienceListResult,
  type SkillExperienceMutationResult,
  type SkillExperiencePromoteResult,
  type SkillExperienceReadResult,
  type SkillExperienceRecord,
  type SkillWorkshopExperience,
} from "../../lib/skill-workshop/experience.ts";
import {
  loadedSkillWorkshopAgentId,
  resolveSkillWorkshopAgentId,
  type SkillWorkshopContext,
} from "./proposals.ts";
import { resetSkillExperienceState, type SkillWorkshopState } from "./state.ts";

export type SkillExperienceLoadOptions = {
  force?: boolean;
  onProgress?: () => void;
  isCurrent?: () => boolean;
};

export type SkillExperienceWriteOutcome = "saved" | "conflict" | "error" | "stale";

export type SkillExperiencePromoteOutcome =
  | { status: "promoted"; proposalId: string }
  | { status: "conflict" | "error" | "stale" };

const generationByState = new WeakMap<SkillWorkshopState, number>();
const detailRequestsByState = new WeakMap<SkillWorkshopState, Map<string, Promise<boolean>>>();
const selectionRequestByState = new WeakMap<SkillWorkshopState, string>();

function readGeneration(state: SkillWorkshopState): number {
  return generationByState.get(state) ?? 0;
}

export function invalidateSkillExperienceReads(state: SkillWorkshopState): void {
  generationByState.set(state, readGeneration(state) + 1);
  state.skillWorkshopExperienceLoaded = false;
  state.skillWorkshopExperienceLoading = false;
  state.skillWorkshopExperienceInspectingId = null;
  detailRequestsByState.delete(state);
}

export function isSkillExperienceRevisionConflict(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    resolveGatewayErrorDetailCode(error) === SKILL_EXPERIENCE_REVISION_CHANGED
  );
}

export function showSkillExperienceNotice(
  state: SkillWorkshopState,
  text: string,
  onProgress?: () => void,
): void {
  if (state.skillWorkshopExperienceNoticeTimer) {
    globalThis.clearTimeout(state.skillWorkshopExperienceNoticeTimer);
  }
  state.skillWorkshopExperienceNotice = text;
  state.skillWorkshopExperienceNoticeTimer = globalThis.setTimeout(() => {
    state.skillWorkshopExperienceNotice = null;
    state.skillWorkshopExperienceNoticeTimer = null;
    onProgress?.();
  }, 6_000);
}

function mergeExperience(
  state: SkillWorkshopState,
  record: SkillExperienceRecord,
  revisionHash?: string,
  content?: string,
): void {
  const entities = state.skillWorkshopExperiences;
  const index = entities.findIndex((entry) => entry.id === record.id);
  const existing = index >= 0 ? entities[index] : undefined;
  const next: SkillWorkshopExperience = {
    ...record,
    revisionHash: revisionHash ?? record.revisionHash,
    content: content ?? existing?.content ?? "",
    contentLoaded: content !== undefined ? true : (existing?.contentLoaded ?? false),
  };
  state.skillWorkshopExperiences =
    index < 0
      ? sortSkillExperiences([next, ...entities])
      : sortSkillExperiences([...entities.slice(0, index), next, ...entities.slice(index + 1)]);
}

function visibleExperiences(state: SkillWorkshopState): SkillWorkshopExperience[] {
  return filterSkillExperiences(
    state.skillWorkshopExperiences,
    state.skillWorkshopExperienceQuery,
    state.skillWorkshopExperienceFilter,
  );
}

function selectVisibleFallback(state: SkillWorkshopState): void {
  const visible = visibleExperiences(state);
  if (visible.some((entry) => entry.id === state.skillWorkshopExperienceSelectedId)) {
    return;
  }
  state.skillWorkshopExperienceSelectedId = visible[0]?.id ?? null;
  if (state.skillWorkshopExperienceSelectedId) {
    selectionRequestByState.set(state, state.skillWorkshopExperienceSelectedId);
  }
}

export async function loadSkillExperiences(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  options?: SkillExperienceLoadOptions,
): Promise<void> {
  const snapshot = context.gateway.snapshot;
  const client = snapshot.client;
  if (!client || snapshot.phase !== "connected" || options?.isCurrent?.() === false) {
    return;
  }
  const requestAgentId = resolveSkillWorkshopAgentId(context);
  if (state.skillWorkshopAgentId !== requestAgentId) {
    state.skillWorkshopAgentId = requestAgentId;
    resetSkillExperienceState(state);
  }
  if (state.skillWorkshopExperienceLoading) {
    return;
  }
  if (state.skillWorkshopExperienceLoaded && !options?.force) {
    return;
  }
  const requestGeneration = readGeneration(state);
  const isCurrentRead = () =>
    readGeneration(state) === requestGeneration &&
    options?.isCurrent?.() !== false &&
    context.gateway.snapshot.client === client &&
    resolveSkillWorkshopAgentId(context) === requestAgentId;
  state.skillWorkshopExperienceLoading = true;
  state.skillWorkshopExperienceError = null;
  try {
    const result = await client.request<SkillExperienceListResult>("skills.experience.list", {
      agentId: requestAgentId,
    });
    if (!isCurrentRead()) {
      return;
    }
    const previous = new Map(state.skillWorkshopExperiences.map((entry) => [entry.id, entry]));
    state.skillWorkshopExperiences = sortSkillExperiences(
      result.experiences.map((record) => {
        const prior = previous.get(record.id);
        // A read body stays valid only while its revision is unchanged.
        const keepContent = prior?.contentLoaded && prior.revisionHash === record.revisionHash;
        return {
          ...record,
          content: keepContent ? prior.content : "",
          contentLoaded: Boolean(keepContent),
        };
      }),
    );
    state.skillWorkshopExperienceCounts = result.counts;
    state.skillWorkshopExperienceLoaded = true;
    selectVisibleFallback(state);
    const selectedId = state.skillWorkshopExperienceSelectedId;
    if (selectedId) {
      await loadSkillExperienceDetail(state, context, selectedId, {
        isCurrent: options?.isCurrent,
      });
    }
  } catch (error) {
    if (isCurrentRead()) {
      state.skillWorkshopExperienceError = formatUiError(error);
    }
  } finally {
    if (readGeneration(state) === requestGeneration) {
      state.skillWorkshopExperienceLoading = false;
      options?.onProgress?.();
      if (
        options?.isCurrent?.() !== false &&
        context.gateway.snapshot.client === client &&
        resolveSkillWorkshopAgentId(context) !== requestAgentId
      ) {
        void loadSkillExperiences(state, context, { ...options, force: true });
      }
    }
  }
}

function detailRequests(state: SkillWorkshopState): Map<string, Promise<boolean>> {
  const existing = detailRequestsByState.get(state);
  if (existing) {
    return existing;
  }
  const requests = new Map<string, Promise<boolean>>();
  detailRequestsByState.set(state, requests);
  return requests;
}

async function readSkillExperience(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  client: NonNullable<SkillWorkshopContext["gateway"]["snapshot"]["client"]>,
  id: string,
  options?: SkillExperienceLoadOptions,
): Promise<boolean> {
  const requestAgentId = loadedSkillWorkshopAgentId(state, context);
  if (state.skillWorkshopAgentId === null) {
    state.skillWorkshopAgentId = requestAgentId;
  }
  const requestGeneration = readGeneration(state);
  const isCurrentRead = () =>
    readGeneration(state) === requestGeneration &&
    options?.isCurrent?.() !== false &&
    context.gateway.snapshot.client === client &&
    state.skillWorkshopAgentId === requestAgentId &&
    resolveSkillWorkshopAgentId(context) === requestAgentId;
  state.skillWorkshopExperienceInspectingId = id;
  try {
    const result = await client.request<SkillExperienceReadResult>("skills.experience.read", {
      agentId: requestAgentId,
      id,
    });
    if (!isCurrentRead()) {
      return false;
    }
    mergeExperience(state, result.record, result.revisionHash, result.content);
    return true;
  } catch (error) {
    // Only the row the operator is waiting on may publish a read error.
    if (isCurrentRead() && selectionRequestByState.get(state) === id) {
      state.skillWorkshopExperienceError = formatUiError(error);
    }
    return false;
  } finally {
    if (isCurrentRead() && state.skillWorkshopExperienceInspectingId === id) {
      state.skillWorkshopExperienceInspectingId = null;
    }
  }
}

export function loadSkillExperienceDetail(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  id: string,
  options?: SkillExperienceLoadOptions,
): Promise<boolean> {
  const snapshot = context.gateway.snapshot;
  const client = snapshot.client;
  if (!client || snapshot.phase !== "connected" || options?.isCurrent?.() === false) {
    return Promise.resolve(false);
  }
  const existing = state.skillWorkshopExperiences.find((entry) => entry.id === id);
  if (existing?.contentLoaded && !options?.force) {
    return Promise.resolve(true);
  }
  const requests = detailRequests(state);
  const inFlight = requests.get(id);
  // A forced reload (the conflict path) must read the owner again instead of
  // reusing an older in-flight read the operator cannot distinguish.
  if (inFlight && !options?.force) {
    return inFlight;
  }
  const request = readSkillExperience(state, context, client, id, options).finally(() => {
    if (requests.get(id) === request) {
      requests.delete(id);
    }
  });
  requests.set(id, request);
  return request;
}

export async function selectSkillExperience(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  id: string,
): Promise<void> {
  selectionRequestByState.set(state, id);
  const current = state.skillWorkshopExperiences.find((entry) => entry.id === id);
  if (!current?.contentLoaded) {
    const loaded = await loadSkillExperienceDetail(state, context, id);
    if (!loaded || selectionRequestByState.get(state) !== id) {
      return;
    }
  }
  state.skillWorkshopExperienceSelectedId = id;
}

export function setSkillExperienceFilter(
  state: SkillWorkshopState,
  filter: SkillWorkshopState["skillWorkshopExperienceFilter"],
): void {
  state.skillWorkshopExperienceFilter = filter;
  selectVisibleFallback(state);
}

export function setSkillExperienceQuery(state: SkillWorkshopState, query: string): void {
  state.skillWorkshopExperienceQuery = query;
  selectVisibleFallback(state);
}

export function startNewSkillExperienceDraft(state: SkillWorkshopState): void {
  state.skillWorkshopExperienceDraft = {
    mode: "create",
    id: null,
    name: "",
    description: "",
    content: "",
    baseRevisionHash: null,
    saving: false,
    error: null,
    conflictHeld: false,
    notice: null,
  };
}

export function startEditSkillExperienceDraft(
  state: SkillWorkshopState,
  experience: SkillWorkshopExperience,
): void {
  state.skillWorkshopExperienceDraft = {
    mode: "edit",
    id: experience.id,
    name: experience.name,
    description: experience.description,
    content: experience.content,
    baseRevisionHash: experience.revisionHash,
    saving: false,
    error: null,
    conflictHeld: false,
    notice: null,
  };
}

export function cancelSkillExperienceDraft(state: SkillWorkshopState): void {
  state.skillWorkshopExperienceDraft = null;
}

export async function saveSkillExperienceDraft(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  options?: SkillExperienceLoadOptions,
): Promise<SkillExperienceWriteOutcome> {
  const draft = state.skillWorkshopExperienceDraft;
  const client = context.gateway.snapshot.client;
  if (!draft || draft.saving || !client || context.gateway.snapshot.phase !== "connected") {
    return "stale";
  }
  const agentId = resolveSkillWorkshopAgentId(context);
  const requestGeneration = readGeneration(state);
  const isCurrentWrite = () =>
    readGeneration(state) === requestGeneration &&
    options?.isCurrent?.() !== false &&
    context.gateway.snapshot.client === client &&
    resolveSkillWorkshopAgentId(context) === agentId &&
    state.skillWorkshopExperienceDraft === draft;
  draft.saving = true;
  draft.error = null;
  options?.onProgress?.();
  const params = {
    agentId,
    name: draft.name.trim(),
    description: draft.description.trim(),
    content: draft.content,
  };
  try {
    const result = await client.request<SkillExperienceMutationResult>(
      draft.mode === "create" ? "skills.experience.create" : "skills.experience.update",
      draft.mode === "create"
        ? params
        : { ...params, id: draft.id, expectedRevisionHash: draft.baseRevisionHash ?? "" },
    );
    if (!isCurrentWrite()) {
      return "stale";
    }
    mergeExperience(state, result.record, result.revisionHash, draft.content);
    state.skillWorkshopExperienceDraft = null;
    if (draft.mode === "create") {
      state.skillWorkshopExperienceFilter = "active";
      state.skillWorkshopExperienceSelectedId = result.record.id;
      selectionRequestByState.set(state, result.record.id);
    }
    return "saved";
  } catch (error) {
    if (!isCurrentWrite()) {
      return "stale";
    }
    draft.saving = false;
    if (isSkillExperienceRevisionConflict(error)) {
      draft.conflictHeld = true;
      draft.error = null;
      return "conflict";
    }
    draft.error = formatUiError(error);
    return "error";
  }
}

export async function reloadSkillExperienceDraftBase(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  options?: SkillExperienceLoadOptions,
): Promise<boolean> {
  const draft = state.skillWorkshopExperienceDraft;
  if (!draft || draft.mode !== "edit" || !draft.id) {
    return false;
  }
  const loaded = await loadSkillExperienceDetail(state, context, draft.id, {
    force: true,
    isCurrent: options?.isCurrent,
  });
  if (!loaded || state.skillWorkshopExperienceDraft !== draft) {
    return false;
  }
  const record = state.skillWorkshopExperiences.find((entry) => entry.id === draft.id);
  if (!record) {
    return false;
  }
  // Keep the operator's text and re-base it on the revision they just reviewed.
  draft.baseRevisionHash = record.revisionHash;
  draft.conflictHeld = false;
  draft.error = null;
  return true;
}

export function startSkillExperiencePromoteDraft(
  state: SkillWorkshopState,
  experience: SkillWorkshopExperience,
): void {
  state.skillWorkshopExperiencePromoteDraft = {
    id: experience.id,
    experienceName: experience.name,
    experienceDescription: experience.description,
    targetKind: "create",
    name: experience.name,
    skillName: "",
    description: experience.description,
    busy: false,
    error: null,
  };
}

export function cancelSkillExperiencePromoteDraft(state: SkillWorkshopState): void {
  state.skillWorkshopExperiencePromoteDraft = null;
}

export async function promoteSkillExperience(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  options?: SkillExperienceLoadOptions,
): Promise<SkillExperiencePromoteOutcome> {
  const draft = state.skillWorkshopExperiencePromoteDraft;
  const client = context.gateway.snapshot.client;
  if (!draft || draft.busy || !client || context.gateway.snapshot.phase !== "connected") {
    return { status: "stale" };
  }
  const record = state.skillWorkshopExperiences.find((entry) => entry.id === draft.id);
  if (!record) {
    return { status: "stale" };
  }
  const agentId = resolveSkillWorkshopAgentId(context);
  const requestGeneration = readGeneration(state);
  const isCurrentWrite = () =>
    readGeneration(state) === requestGeneration &&
    options?.isCurrent?.() !== false &&
    context.gateway.snapshot.client === client &&
    resolveSkillWorkshopAgentId(context) === agentId &&
    state.skillWorkshopExperiencePromoteDraft === draft;
  draft.busy = true;
  draft.error = null;
  options?.onProgress?.();
  const description = draft.description.trim();
  const target =
    draft.targetKind === "create"
      ? { kind: "create" as const, name: draft.name.trim(), description }
      : {
          kind: "update" as const,
          skillName: draft.skillName,
          ...(description ? { description } : {}),
        };
  try {
    const result = await client.request<SkillExperiencePromoteResult>("skills.experience.promote", {
      agentId,
      id: draft.id,
      expectedRevisionHash: record.revisionHash,
      target,
    });
    if (!isCurrentWrite()) {
      return { status: "stale" };
    }
    mergeExperience(state, result.record, result.revisionHash);
    state.skillWorkshopExperiencePromoteDraft = null;
    // The promotion moves the document out of the candidate filter; keep it in
    // view when the operator returns from reviewing the suggestion.
    state.skillWorkshopExperienceFilter = "promoted";
    state.skillWorkshopExperienceSelectedId = result.record.id;
    selectionRequestByState.set(state, result.record.id);
    return { status: "promoted", proposalId: result.proposal.id };
  } catch (error) {
    if (!isCurrentWrite()) {
      return { status: "stale" };
    }
    draft.busy = false;
    if (isSkillExperienceRevisionConflict(error)) {
      return { status: "conflict" };
    }
    draft.error = formatUiError(error);
    return { status: "error" };
  }
}

export function startSkillExperienceRetireDraft(
  state: SkillWorkshopState,
  experience: SkillWorkshopExperience,
): void {
  state.skillWorkshopExperienceRetireDraft = {
    id: experience.id,
    experienceName: experience.name,
    reason: "",
    busy: false,
    error: null,
  };
}

export function cancelSkillExperienceRetireDraft(state: SkillWorkshopState): void {
  state.skillWorkshopExperienceRetireDraft = null;
}

export async function retireSkillExperience(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  options?: SkillExperienceLoadOptions,
): Promise<SkillExperienceWriteOutcome> {
  const draft = state.skillWorkshopExperienceRetireDraft;
  const client = context.gateway.snapshot.client;
  if (!draft || draft.busy || !client || context.gateway.snapshot.phase !== "connected") {
    return "stale";
  }
  const record = state.skillWorkshopExperiences.find((entry) => entry.id === draft.id);
  if (!record) {
    return "stale";
  }
  const agentId = resolveSkillWorkshopAgentId(context);
  const requestGeneration = readGeneration(state);
  const isCurrentWrite = () =>
    readGeneration(state) === requestGeneration &&
    options?.isCurrent?.() !== false &&
    context.gateway.snapshot.client === client &&
    resolveSkillWorkshopAgentId(context) === agentId &&
    state.skillWorkshopExperienceRetireDraft === draft;
  draft.busy = true;
  draft.error = null;
  options?.onProgress?.();
  try {
    const reason = draft.reason.trim();
    const result = await client.request<SkillExperienceMutationResult>("skills.experience.retire", {
      agentId,
      id: record.id,
      expectedRevisionHash: record.revisionHash,
      ...(reason ? { reason } : {}),
    });
    if (!isCurrentWrite()) {
      return "stale";
    }
    mergeExperience(state, result.record, result.revisionHash);
    state.skillWorkshopExperienceRetireDraft = null;
    selectVisibleFallback(state);
    return "saved";
  } catch (error) {
    if (!isCurrentWrite()) {
      return "stale";
    }
    draft.busy = false;
    if (isSkillExperienceRevisionConflict(error)) {
      return "conflict";
    }
    draft.error = formatUiError(error);
    return "error";
  }
}

export async function restoreSkillExperience(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  id: string,
  options?: SkillExperienceLoadOptions,
): Promise<SkillExperienceWriteOutcome> {
  const client = context.gateway.snapshot.client;
  const record = state.skillWorkshopExperiences.find((entry) => entry.id === id);
  if (
    !client ||
    !record ||
    context.gateway.snapshot.phase !== "connected" ||
    state.skillWorkshopExperienceBusy
  ) {
    return "stale";
  }
  const agentId = resolveSkillWorkshopAgentId(context);
  const requestGeneration = readGeneration(state);
  const isCurrentWrite = () =>
    readGeneration(state) === requestGeneration &&
    options?.isCurrent?.() !== false &&
    context.gateway.snapshot.client === client &&
    resolveSkillWorkshopAgentId(context) === agentId;
  state.skillWorkshopExperienceBusy = { id, action: "restore" };
  options?.onProgress?.();
  try {
    const result = await client.request<SkillExperienceMutationResult>(
      "skills.experience.restore",
      { agentId, id, expectedRevisionHash: record.revisionHash },
    );
    if (!isCurrentWrite()) {
      return "stale";
    }
    mergeExperience(state, result.record, result.revisionHash);
    state.skillWorkshopExperienceBusy = null;
    state.skillWorkshopExperienceFilter = "active";
    state.skillWorkshopExperienceSelectedId = result.record.id;
    selectionRequestByState.set(state, result.record.id);
    return "saved";
  } catch (error) {
    if (!isCurrentWrite()) {
      return "stale";
    }
    state.skillWorkshopExperienceBusy = null;
    return isSkillExperienceRevisionConflict(error) ? "conflict" : "error";
  }
}
