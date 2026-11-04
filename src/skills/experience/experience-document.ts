import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SkillExperienceEvidence,
  SkillExperienceOrigin,
  SkillExperienceProject,
  SkillExperienceRecord,
  SkillExperienceStatus,
} from "../../../packages/gateway-protocol/src/schema/skill-experience.js";
import { extractFrontmatterBlock } from "../../../packages/markdown-core/src/frontmatter.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { readLocalFileSafely } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { parseSkillFrontmatter } from "../loading/frontmatter.js";
import { loadSkillRootRecords, warnInvalidSkill } from "../loading/skill-root-loader.js";
import { scanSkillContent, scanSource } from "../security/scanner.js";
import {
  metadataFromFrontmatter,
  renderExperienceDocument,
  type ExperienceWriteMetadata,
} from "./experience-metadata.js";
import {
  assertExperienceId,
  EXPERIENCE_DOCUMENT_FILE,
  EXPERIENCE_MAX_DESCRIPTION_BYTES,
  EXPERIENCE_SOURCE,
  normalizeExperienceId,
  resolveExperienceRoot,
  resolveRetiredExperienceRoot,
} from "./experience-root.js";

export class ExperienceRevisionChangedError extends Error {
  constructor(
    readonly expectedRevisionHash: string,
    readonly currentRevisionHash: string,
  ) {
    super("Experience changed since it was read; reload it and retry with the current revision.");
    this.name = "ExperienceRevisionChangedError";
  }
}

export class ExperienceNotFoundError extends Error {
  constructor(id: string) {
    super(`Experience not found: ${id}`);
    this.name = "ExperienceNotFoundError";
  }
}

export type ExperienceDocument = {
  id: string;
  metadata: ExperienceWriteMetadata;
  body: string;
  content: string;
  revisionHash: string;
  retired: boolean;
};

type ExperienceFileRecord = {
  id: string;
  metadata: ExperienceWriteMetadata;
  revisionHash: string;
  filePath: string;
  retired: boolean;
};

const MAX_EXPERIENCE_BYTES_DEFAULT = 256_000;
const writeLocks = new Map<string, Promise<unknown>>();

function maxExperienceBytes(config: OpenClawConfig): number {
  return config.skills?.limits?.maxSkillFileBytes ?? MAX_EXPERIENCE_BYTES_DEFAULT;
}

function requireAgentId(agentId: string | undefined): string {
  const normalized = normalizeOptionalString(agentId);
  if (!normalized) {
    throw new Error("Experience documents require the active agent id.");
  }
  return normalized;
}

function assertDescription(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new Error("Experience description is required.");
  }
  if (Buffer.byteLength(normalized, "utf8") > EXPERIENCE_MAX_DESCRIPTION_BYTES) {
    throw new Error(
      `Experience description must be at most ${EXPERIENCE_MAX_DESCRIPTION_BYTES} bytes.`,
    );
  }
  return normalized;
}

function assertBody(body: string, config: OpenClawConfig): string {
  if (!body.trim()) {
    throw new Error("Experience content is required.");
  }
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimStart();
  if (Buffer.byteLength(normalized, "utf8") > maxExperienceBytes(config)) {
    throw new Error(
      `Experience content exceeds the configured skills.limits.maxSkillFileBytes (${maxExperienceBytes(config)}).`,
    );
  }
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function normalizeTags(tags: readonly string[] | undefined): string[] | undefined {
  const normalized = (tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function freeTextMetadata(...values: unknown[]): string[] {
  const texts: string[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      texts.push(value);
    } else if (Array.isArray(value)) {
      texts.push(...freeTextMetadata(...value));
    } else if (isRecord(value)) {
      texts.push(...freeTextMetadata(...Object.values(value)));
    }
  }
  return texts;
}

function assertNoLiteralSecrets(params: {
  body: string;
  name: string;
  description: string;
  metadata: readonly string[];
}): void {
  const findings = [
    ...scanSkillContent(params.body, EXPERIENCE_DOCUMENT_FILE),
    ...scanSource(params.body, EXPERIENCE_DOCUMENT_FILE),
    ...params.metadata.flatMap((value) =>
      scanSkillContent(value, "experience-metadata").filter(
        (finding) => finding.ruleId === "literal-secret",
      ),
    ),
    ...scanSkillContent(params.name, "experience-name").filter(
      (finding) => finding.ruleId === "literal-secret",
    ),
    ...scanSkillContent(params.description, "experience-description").filter(
      (finding) => finding.ruleId === "literal-secret",
    ),
  ];
  const finding = findings.find((entry) => entry.ruleId === "literal-secret");
  if (finding) {
    throw new Error(
      `Experience contains a recognized literal credential in ${finding.file}; replace it with a SecretRef or placeholder.`,
    );
  }
}

async function listExperienceFileRecords(params: {
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
  retired: boolean;
}): Promise<ExperienceFileRecord[]> {
  const rootPath = params.retired
    ? resolveRetiredExperienceRoot(params.config, params.agentId, params.env)
    : resolveExperienceRoot(params.config, params.agentId, params.env);
  const records = loadSkillRootRecords({
    dir: rootPath,
    source: EXPERIENCE_SOURCE,
    instructionFile: EXPERIENCE_DOCUMENT_FILE,
    config: params.config,
    onDiagnostic: (diagnostic) => {
      if (diagnostic.kind === "read") {
        throw new Error(
          `Experience documents could not be read. Check access to ${rootPath}, then retry.`,
        );
      }
      warnInvalidSkill(EXPERIENCE_SOURCE, diagnostic);
    },
  });
  const result: ExperienceFileRecord[] = [];
  for (const record of records) {
    const id = path.basename(record.skill.baseDir);
    try {
      assertExperienceId(id);
      const stat = await fs.stat(record.skill.filePath);
      result.push({
        id,
        metadata: metadataFromFrontmatter({
          frontmatter: record.frontmatter,
          fallbackName: id,
          fallbackTimestamp: stat.mtime.toISOString(),
          retired: params.retired,
        }),
        revisionHash: record.skill.contentHash ?? "",
        filePath: record.skill.filePath,
        retired: params.retired,
      });
    } catch {
      warnInvalidSkill(EXPERIENCE_SOURCE, {
        kind: "invalid",
        path: record.skill.filePath,
        message: `Experience directory id must be a lowercase slug: ${id}`,
      });
    }
  }
  return result;
}

export async function listExperienceFiles(params: {
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ExperienceFileRecord[]> {
  const agentId = requireAgentId(params.agentId);
  const [active, retired] = await Promise.all([
    listExperienceFileRecords({ ...params, agentId, retired: false }),
    listExperienceFileRecords({ ...params, agentId, retired: true }),
  ]);
  return [...active, ...retired].toSorted(
    (left, right) =>
      left.id.localeCompare(right.id) || Number(left.retired) - Number(right.retired),
  );
}

async function readDocumentAt(
  filePath: string,
  id: string,
  retired: boolean,
  maxBytes: number,
): Promise<ExperienceDocument> {
  const result = await readLocalFileSafely({ filePath, maxBytes });
  const content = result.buffer.toString("utf8");
  let frontmatter: Record<string, string>;
  try {
    frontmatter = parseSkillFrontmatter(content);
  } catch (error) {
    throw new Error(
      `Experience ${id} has invalid frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const stat = await fs.stat(filePath);
  const metadata = metadataFromFrontmatter({
    frontmatter,
    fallbackName: id,
    fallbackTimestamp: stat.mtime.toISOString(),
    retired,
  });
  const body = (extractFrontmatterBlock(content)?.body ?? "").replace(/^\n+/u, "");
  return {
    id,
    metadata,
    body,
    content,
    revisionHash: sha256Hex(content),
    retired,
  };
}

export async function readExperienceFile(params: {
  config: OpenClawConfig;
  agentId: string;
  id: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ExperienceDocument> {
  const agentId = requireAgentId(params.agentId);
  const id = assertExperienceId(params.id);
  const files = await listExperienceFiles({ config: params.config, agentId, env: params.env });
  const entry = files.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new ExperienceNotFoundError(id);
  }
  return await readDocumentAt(entry.filePath, id, entry.retired, maxExperienceBytes(params.config));
}

async function ensureContainedRoot(rootPath: string): Promise<string> {
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  return await fs.realpath(rootPath);
}

async function assertContainedDocumentDir(rootPath: string, dirPath: string): Promise<void> {
  const rootReal = await ensureContainedRoot(rootPath);
  try {
    const stat = await fs.lstat(dirPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Experience document path must be a real directory.");
    }
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
    } else {
      throw error;
    }
  }
  const dirReal = await fs.realpath(dirPath);
  if (dirReal !== rootReal && !isPathInside(rootReal, dirReal)) {
    throw new Error("Experience document path escapes the agent experience root.");
  }
}

async function writeDocumentFile(dirPath: string, content: string): Promise<void> {
  const target = path.join(dirPath, EXPERIENCE_DOCUMENT_FILE);
  const temp = path.join(dirPath, `.${EXPERIENCE_DOCUMENT_FILE}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

function withExperienceWriteLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(key) ?? Promise.resolve();
  const result = previous.then(run, run);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  writeLocks.set(key, tail);
  void tail.finally(() => {
    if (writeLocks.get(key) === tail) {
      writeLocks.delete(key);
    }
  });
  return result;
}

export type CreateExperienceInput = {
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
  name: string;
  description: string;
  content: string;
  tags?: string[];
  capture?: SkillExperienceRecord["capture"];
  origin?: SkillExperienceOrigin;
  evidence?: SkillExperienceEvidence;
  project?: SkillExperienceProject;
};

export async function createExperienceFile(
  input: CreateExperienceInput,
): Promise<ExperienceDocument> {
  const agentId = requireAgentId(input.agentId);
  const name = normalizeOptionalString(input.name);
  if (!name) {
    throw new Error("Experience name is required.");
  }
  const description = assertDescription(input.description);
  const body = assertBody(input.content, input.config);
  const id = assertExperienceId(normalizeExperienceId(name));
  const tags = normalizeTags(input.tags);
  const rootPath = resolveExperienceRoot(input.config, agentId, input.env);
  const dirPath = path.join(rootPath, id);
  const retiredPath = path.join(resolveRetiredExperienceRoot(input.config, agentId, input.env), id);
  assertNoLiteralSecrets({
    body,
    name,
    description,
    metadata: freeTextMetadata(tags, input.evidence, input.project),
  });
  return await withExperienceWriteLock(dirPath, async () => {
    if (await pathExists(dirPath)) {
      throw new Error(`Experience already exists: ${id}`);
    }
    if (await pathExists(retiredPath)) {
      throw new Error(
        `A retired Experience already uses this id: ${id}. Restore it instead of creating a duplicate.`,
      );
    }
    await assertContainedDocumentDir(rootPath, dirPath);
    const now = new Date().toISOString();
    const metadata: ExperienceWriteMetadata = {
      name,
      description,
      createdAt: now,
      updatedAt: now,
      ...(tags ? { tags } : {}),
      ...(input.capture ? { capture: input.capture } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.project ? { project: input.project } : {}),
    };
    const content = renderExperienceDocument(metadata, body);
    await writeDocumentFile(dirPath, content);
    return {
      id,
      metadata,
      body,
      content,
      revisionHash: sha256Hex(content),
      retired: false,
    };
  });
}

export type UpdateExperienceInput = {
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
  id: string;
  expectedRevisionHash: string;
  name?: string;
  description?: string;
  content?: string;
  tags?: string[];
};

export async function updateExperienceFile(
  input: UpdateExperienceInput,
): Promise<ExperienceDocument> {
  const agentId = requireAgentId(input.agentId);
  const id = assertExperienceId(input.id);
  const rootPath = resolveExperienceRoot(input.config, agentId, input.env);
  const dirPath = path.join(rootPath, id);
  return await withExperienceWriteLock(dirPath, async () => {
    const existing = await readExperienceFile({
      config: input.config,
      agentId,
      id,
      ...(input.env ? { env: input.env } : {}),
    });
    if (existing.retired) {
      throw new Error(`Experience is retired; restore it before editing: ${id}`);
    }
    if (existing.revisionHash !== input.expectedRevisionHash) {
      throw new ExperienceRevisionChangedError(input.expectedRevisionHash, existing.revisionHash);
    }
    const name = input.name === undefined ? existing.metadata.name : input.name.trim();
    if (!name) {
      throw new Error("Experience name is required.");
    }
    const description =
      input.description === undefined
        ? existing.metadata.description
        : assertDescription(input.description);
    const body =
      input.content === undefined ? existing.body : assertBody(input.content, input.config);
    const tags = input.tags === undefined ? existing.metadata.tags : normalizeTags(input.tags);
    assertNoLiteralSecrets({
      body,
      name,
      description,
      metadata: freeTextMetadata(tags, existing.metadata.evidence, existing.metadata.project),
    });
    const metadata: ExperienceWriteMetadata = {
      ...existing.metadata,
      name,
      description,
      updatedAt: new Date().toISOString(),
      ...(tags ? { tags } : {}),
    };
    if (!tags) {
      delete metadata.tags;
    }
    const content = renderExperienceDocument(metadata, body, existing.content);
    await assertContainedDocumentDir(rootPath, dirPath);
    await writeDocumentFile(dirPath, content);
    return {
      id,
      metadata,
      body,
      content,
      revisionHash: sha256Hex(content),
      retired: false,
    };
  });
}

export async function retireExperienceFile(params: {
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
  id: string;
  expectedRevisionHash: string;
  reason?: string;
}): Promise<ExperienceDocument> {
  const agentId = requireAgentId(params.agentId);
  const id = assertExperienceId(params.id);
  const rootPath = resolveExperienceRoot(params.config, agentId, params.env);
  const retiredRoot = resolveRetiredExperienceRoot(params.config, agentId, params.env);
  const dirPath = path.join(rootPath, id);
  const retiredPath = path.join(retiredRoot, id);
  return await withExperienceWriteLock(dirPath, async () => {
    const existing = await readExperienceFile({
      config: params.config,
      agentId,
      id,
      ...(params.env ? { env: params.env } : {}),
    });
    if (existing.retired) {
      throw new Error(`Experience is already retired: ${id}`);
    }
    if (existing.revisionHash !== params.expectedRevisionHash) {
      throw new ExperienceRevisionChangedError(params.expectedRevisionHash, existing.revisionHash);
    }
    if (await pathExists(retiredPath)) {
      throw new Error(`Retired Experience path already exists: ${retiredPath}`);
    }
    assertNoLiteralSecrets({
      body: existing.body,
      name: existing.metadata.name,
      description: existing.metadata.description,
      metadata: freeTextMetadata(params.reason),
    });
    const metadata: ExperienceWriteMetadata = {
      ...existing.metadata,
      updatedAt: new Date().toISOString(),
      retiredAt: new Date().toISOString(),
      ...(normalizeOptionalString(params.reason)
        ? { retireReason: normalizeOptionalString(params.reason)! }
        : {}),
    };
    const content = renderExperienceDocument(metadata, existing.body, existing.content);
    await assertContainedDocumentDir(rootPath, dirPath);
    await writeDocumentFile(dirPath, content);
    try {
      await ensureContainedRoot(retiredRoot);
      await fs.rename(dirPath, retiredPath);
    } catch (error) {
      await writeDocumentFile(dirPath, existing.content);
      throw error;
    }
    return {
      id,
      metadata,
      body: existing.body,
      content,
      revisionHash: sha256Hex(content),
      retired: true,
    };
  });
}

export async function restoreExperienceFile(params: {
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
  id: string;
  expectedRevisionHash?: string;
}): Promise<ExperienceDocument> {
  const agentId = requireAgentId(params.agentId);
  const id = assertExperienceId(params.id);
  const rootPath = resolveExperienceRoot(params.config, agentId, params.env);
  const retiredRoot = resolveRetiredExperienceRoot(params.config, agentId, params.env);
  const dirPath = path.join(rootPath, id);
  const retiredPath = path.join(retiredRoot, id);
  return await withExperienceWriteLock(dirPath, async () => {
    const existing = await readExperienceFile({
      config: params.config,
      agentId,
      id,
      ...(params.env ? { env: params.env } : {}),
    });
    if (!existing.retired) {
      throw new Error(`Experience is already active: ${id}`);
    }
    if (
      params.expectedRevisionHash !== undefined &&
      existing.revisionHash !== params.expectedRevisionHash
    ) {
      throw new ExperienceRevisionChangedError(params.expectedRevisionHash, existing.revisionHash);
    }
    if (await pathExists(dirPath)) {
      throw new Error(`Active Experience path already exists: ${dirPath}`);
    }
    const metadata: ExperienceWriteMetadata = {
      ...existing.metadata,
      updatedAt: new Date().toISOString(),
    };
    delete metadata.retiredAt;
    delete metadata.retireReason;
    const content = renderExperienceDocument(metadata, existing.body, existing.content);
    await assertContainedDocumentDir(retiredRoot, retiredPath);
    await writeDocumentFile(retiredPath, content);
    try {
      await ensureContainedRoot(rootPath);
      await fs.rename(retiredPath, dirPath);
    } catch (error) {
      await writeDocumentFile(retiredPath, existing.content);
      throw error;
    }
    return {
      id,
      metadata,
      body: existing.body,
      content,
      revisionHash: sha256Hex(content),
      retired: false,
    };
  });
}

/** Records the promotion link without changing the document body. */
export async function linkExperiencePromotion(params: {
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
  id: string;
  expectedRevisionHash: string;
  promotion: NonNullable<ExperienceWriteMetadata["promotion"]>;
}): Promise<ExperienceDocument> {
  const agentId = requireAgentId(params.agentId);
  const id = assertExperienceId(params.id);
  const rootPath = resolveExperienceRoot(params.config, agentId, params.env);
  const dirPath = path.join(rootPath, id);
  return await withExperienceWriteLock(dirPath, async () => {
    const existing = await readExperienceFile({
      config: params.config,
      agentId,
      id,
      ...(params.env ? { env: params.env } : {}),
    });
    if (existing.retired) {
      throw new Error(`Experience is retired: ${id}`);
    }
    if (existing.revisionHash !== params.expectedRevisionHash) {
      throw new ExperienceRevisionChangedError(params.expectedRevisionHash, existing.revisionHash);
    }
    const metadata: ExperienceWriteMetadata = {
      ...existing.metadata,
      updatedAt: new Date().toISOString(),
      promotion: params.promotion,
    };
    const content = renderExperienceDocument(metadata, existing.body, existing.content);
    await assertContainedDocumentDir(rootPath, dirPath);
    await writeDocumentFile(dirPath, content);
    return {
      id,
      metadata,
      body: existing.body,
      content,
      revisionHash: sha256Hex(content),
      retired: false,
    };
  });
}

export function experienceStatus(record: {
  retired: boolean;
  promotion?: { state: "pending" | "applied" | "rejected" };
}): SkillExperienceStatus {
  if (record.retired) {
    return "retired";
  }
  const state = record.promotion?.state;
  return state === "pending" || state === "applied" ? "promoted" : "active";
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}
