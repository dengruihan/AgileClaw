import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SkillExperienceEvidence,
  SkillExperienceOrigin,
  SkillExperienceProject,
  SkillExperiencePromotion,
  SkillExperienceRecord,
} from "../../../packages/gateway-protocol/src/schema/skill-experience.js";
import { extractFrontmatterBlock } from "../../../packages/markdown-core/src/frontmatter.js";

export type ExperienceWriteMetadata = {
  name: string;
  description: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  capture?: SkillExperienceRecord["capture"];
  origin?: SkillExperienceOrigin;
  evidence?: SkillExperienceEvidence;
  project?: SkillExperienceProject;
  /** Stored link only; projected promotion state is resolved from the proposal owner. */
  promotion?: ExperiencePromotionLink;
  retiredAt?: string;
  retireReason?: string;
};

export type ExperiencePromotionLink = Pick<
  SkillExperiencePromotion,
  "proposalId" | "targetKind" | "targetSkillName"
>;

const OWNED_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "tags",
  "created-at",
  "updated-at",
  "capture",
  "origin",
  "evidence",
  "project",
  "promotion",
  "retired-at",
  "retire-reason",
]);

function filterPreservedFrontmatter(block: string): string {
  const lines = block.split("\n");
  const kept: string[] = [];
  let dropping = false;
  for (const line of lines) {
    const key = line.match(/^([\w-]+):/)?.[1]?.toLowerCase();
    if (key) {
      dropping = OWNED_FRONTMATTER_KEYS.has(key);
    }
    if (!dropping) {
      kept.push(line);
    }
  }
  return kept.join("\n").trim();
}

function renderJsonField(value: unknown): string {
  return JSON.stringify(JSON.stringify(value));
}

export function renderExperienceDocument(
  metadata: ExperienceWriteMetadata,
  body: string,
  previousContent?: string,
): string {
  const preserved = previousContent
    ? filterPreservedFrontmatter(extractFrontmatterBlock(previousContent)?.block ?? "")
    : "";
  const lines = [
    `name: ${JSON.stringify(metadata.name)}`,
    `description: ${JSON.stringify(metadata.description)}`,
  ];
  if (metadata.tags?.length) {
    lines.push(`tags: ${renderJsonField(metadata.tags)}`);
  }
  lines.push(`created-at: ${JSON.stringify(metadata.createdAt)}`);
  lines.push(`updated-at: ${JSON.stringify(metadata.updatedAt)}`);
  if (metadata.capture) {
    lines.push(`capture: ${JSON.stringify(metadata.capture)}`);
  }
  if (metadata.origin) {
    lines.push(`origin: ${renderJsonField(metadata.origin)}`);
  }
  if (metadata.evidence) {
    lines.push(`evidence: ${renderJsonField(metadata.evidence)}`);
  }
  if (metadata.project) {
    lines.push(`project: ${renderJsonField(metadata.project)}`);
  }
  if (metadata.promotion) {
    const { proposalId, targetKind, targetSkillName } = metadata.promotion;
    lines.push(`promotion: ${renderJsonField({ proposalId, targetKind, targetSkillName })}`);
  }
  if (metadata.retiredAt) {
    lines.push(`retired-at: ${JSON.stringify(metadata.retiredAt)}`);
  }
  if (metadata.retireReason) {
    lines.push(`retire-reason: ${JSON.stringify(metadata.retireReason)}`);
  }
  if (preserved) {
    lines.push(preserved);
  }
  return `---\n${lines.join("\n")}\n---\n\n${body.trimEnd()}\n`;
}

function readJsonField<T>(
  frontmatter: Record<string, string>,
  key: string,
  guard: (value: unknown) => value is T,
): T | undefined {
  const raw = frontmatter[key];
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return guard(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseTags(frontmatter: Record<string, string>): string[] | undefined {
  const json = readJsonField(frontmatter, "tags", (value): value is unknown[] =>
    Array.isArray(value),
  );
  if (json) {
    return json
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  const raw = frontmatter.tags;
  return raw
    ? raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : undefined;
}

function parseOrigin(frontmatter: Record<string, string>): SkillExperienceOrigin | undefined {
  return readJsonField(frontmatter, "origin", (value): value is SkillExperienceOrigin =>
    isRecord(value),
  );
}

function parseEvidence(frontmatter: Record<string, string>): SkillExperienceEvidence | undefined {
  const evidence = readJsonField(
    frontmatter,
    "evidence",
    (value): value is SkillExperienceEvidence =>
      isRecord(value) &&
      ["observed", "reported", "unverified"].includes(String(value.verification)),
  );
  return evidence;
}

function parseProject(frontmatter: Record<string, string>): SkillExperienceProject | undefined {
  return readJsonField(frontmatter, "project", (value): value is SkillExperienceProject =>
    isRecord(value),
  );
}

function parsePromotion(frontmatter: Record<string, string>): ExperienceWriteMetadata["promotion"] {
  return readJsonField(
    frontmatter,
    "promotion",
    (value): value is ExperiencePromotionLink =>
      isRecord(value) &&
      typeof value.proposalId === "string" &&
      (value.targetKind === "create" || value.targetKind === "update") &&
      typeof value.targetSkillName === "string",
  );
}

export function metadataFromFrontmatter(params: {
  frontmatter: Record<string, string>;
  fallbackName: string;
  fallbackTimestamp: string;
  retired: boolean;
}): ExperienceWriteMetadata {
  const name = params.frontmatter.name?.trim() || params.fallbackName;
  const description = params.frontmatter.description?.trim();
  if (!name) {
    throw new Error("Experience name is required.");
  }
  if (!description) {
    throw new Error("Experience description is required.");
  }
  const createdAt =
    normalizeOptionalString(params.frontmatter["created-at"]) ?? params.fallbackTimestamp;
  const updatedAt = normalizeOptionalString(params.frontmatter["updated-at"]) ?? createdAt;
  const tags = parseTags(params.frontmatter);
  const origin = parseOrigin(params.frontmatter);
  const evidence = parseEvidence(params.frontmatter);
  const project = parseProject(params.frontmatter);
  const promotion = parsePromotion(params.frontmatter);
  const capture = params.frontmatter.capture;
  const retiredAt = params.retired
    ? normalizeOptionalString(params.frontmatter["retired-at"])
    : undefined;
  const retireReason = params.retired
    ? normalizeOptionalString(params.frontmatter["retire-reason"])
    : undefined;
  return {
    name,
    description,
    createdAt,
    updatedAt,
    ...(tags ? { tags } : {}),
    ...(capture === "manual" || capture === "automatic" || capture === "learning-session"
      ? { capture }
      : {}),
    ...(origin ? { origin } : {}),
    ...(evidence ? { evidence } : {}),
    ...(project ? { project } : {}),
    ...(promotion ? { promotion } : {}),
    ...(retiredAt ? { retiredAt } : {}),
    ...(retireReason ? { retireReason } : {}),
  };
}
