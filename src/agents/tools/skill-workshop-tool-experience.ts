import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureExperience,
  listExperiences,
  readExperience,
  updateExperience,
  type ExperienceScope,
} from "../../skills/experience/experience-service.js";
import type { SkillProposalOrigin } from "../../skills/workshop/types.js";
import { readToolStringParam, ToolInputError } from "./common.js";
import { textResult } from "./tool-results.js";

export const EXPERIENCE_TOOL_ACTIONS = [
  "experience_list",
  "experience_read",
  "experience_capture",
  "experience_update",
] as const;

type ExperienceToolOptions = {
  config: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  origin?: SkillProposalOrigin;
  experienceCaptureBudget?: { used: boolean; ids: string[] };
  maxChars: number;
};

function scope(options: ExperienceToolOptions): ExperienceScope {
  return {
    config: options.config,
    agentId: options.agentId,
    workspaceDir: options.workspaceDir,
    ...(options.env ? { env: options.env } : {}),
  };
}

function originForCapture(options: ExperienceToolOptions) {
  const origin = options.origin;
  return origin
    ? {
        ...(origin.agentId ? { agentId: origin.agentId } : {}),
        ...(origin.sessionKey ? { sessionKey: origin.sessionKey } : {}),
        ...(origin.runId ? { runId: origin.runId } : {}),
        ...(origin.messageId ? { messageId: origin.messageId } : {}),
      }
    : undefined;
}

export async function executeExperienceAction(
  action: (typeof EXPERIENCE_TOOL_ACTIONS)[number],
  params: Record<string, unknown>,
  options: ExperienceToolOptions,
) {
  if (action === "experience_list") {
    const result = await listExperiences(scope(options));
    const shown = result.experiences.slice(0, 50);
    const text = truncateUtf16Safe(
      [
        `Experiences: ${result.counts.active} active, ${result.counts.promoted} promoted, ${result.counts.retired} retired.`,
        ...shown.map(
          (record) =>
            `- ${record.id} [${record.status}] ${record.name}: ${record.description}${record.promotion ? ` (promotion ${record.promotion.state})` : ""}`,
        ),
        ...(result.experiences.length > shown.length
          ? [`(+${result.experiences.length - shown.length} more not shown)`]
          : []),
      ].join("\n"),
      options.maxChars,
    );
    return textResult(text, { counts: result.counts, experiences: shown });
  }

  if (action === "experience_read") {
    const id = readToolStringParam(params, "experience_id", {
      required: true,
      label: "experience_id",
    });
    const result = await readExperience(scope(options), id);
    const header = [
      `Experience: ${result.record.id} [${result.record.status}]`,
      `Name: ${result.record.name}`,
      `Description: ${result.record.description}`,
      ...(result.record.promotion
        ? [
            `Promotion: ${result.record.promotion.state} -> ${result.record.promotion.targetKind} ${result.record.promotion.targetSkillName} (${result.record.promotion.proposalId})`,
          ]
        : []),
      "",
    ].join("\n");
    const budget = Math.max(0, options.maxChars - header.length);
    const truncated = result.content.length > budget;
    // A partial read must not authorize a whole-body replace.
    const text = truncated
      ? `${header}Content omitted: the complete experience exceeds the selected-model read budget. Use a description-only update or operator/CLI access for the full document.`
      : `${header}Revision: ${result.revisionHash}\n\n${result.content}`;
    return textResult(text, {
      id: result.record.id,
      status: result.record.status,
      ...(truncated ? {} : { revisionHash: result.revisionHash }),
      contentIncluded: !truncated,
    });
  }

  if (action === "experience_capture") {
    const name = readToolStringParam(params, "name", { required: true, label: "name" });
    const description = readToolStringParam(params, "description", {
      required: true,
      label: "description",
    });
    const content = readToolStringParam(params, "experience_content", {
      required: true,
      label: "experience_content",
    });
    if (options.experienceCaptureBudget?.used) {
      throw new ToolInputError("This run already captured one Experience; reuse or update it.");
    }
    const result = await captureExperience(scope(options), {
      name,
      description,
      content,
      ...(originForCapture(options) ? { origin: originForCapture(options) } : {}),
      ...(readToolStringParam(params, "evidence")
        ? {
            evidence: {
              verification: "observed" as const,
              summary: readToolStringParam(params, "evidence"),
            },
          }
        : {}),
      project: { workspaceDir: options.workspaceDir },
    });
    if (options.experienceCaptureBudget) {
      options.experienceCaptureBudget.used = true;
      options.experienceCaptureBudget.ids.push(result.record.id);
    }
    return textResult(
      `${result.created ? "Captured" : "Reused"} Experience ${result.record.id} (${result.record.status}).`,
      {
        id: result.record.id,
        status: result.record.status,
        revisionHash: result.revisionHash,
        created: result.created,
      },
    );
  }

  const id = readToolStringParam(params, "experience_id", {
    required: true,
    label: "experience_id",
  });
  const expectedRevisionHash = readToolStringParam(params, "expected_experience_hash", {
    required: true,
    label: "expected_experience_hash",
  });
  const content = readToolStringParam(params, "experience_content");
  const description = readToolStringParam(params, "description");
  if (content === undefined && description === undefined) {
    throw new ToolInputError(
      "experience_update requires experience_content or description after reading the document.",
    );
  }
  const result = await updateExperience(scope(options), {
    id,
    expectedRevisionHash,
    ...(content !== undefined ? { content } : {}),
    ...(description !== undefined ? { description } : {}),
  });
  return textResult(`Updated Experience ${result.record.id} (${result.record.status}).`, {
    id: result.record.id,
    status: result.record.status,
    revisionHash: result.revisionHash,
  });
}
