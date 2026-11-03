import {
  validateSkillExperienceCreateParams,
  validateSkillExperienceListParams,
  validateSkillExperiencePromoteParams,
  validateSkillExperienceReadParams,
  validateSkillExperienceRestoreParams,
  validateSkillExperienceRetireParams,
  validateSkillExperienceUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  createExperience,
  listExperiences,
  promoteExperience,
  readExperience,
  restoreExperience,
  retireExperience,
  updateExperience,
  type ExperienceScope,
} from "../../skills/experience/experience-service.js";
import {
  defineSkillsProposalWorkspaceHandler,
  type ResolvedSkillsWorkspace,
} from "./skills-workspace-handler.js";
import type { GatewayRequestHandlers } from "./types.js";

function scope(resolved: ResolvedSkillsWorkspace): ExperienceScope {
  return {
    config: resolved.cfg,
    agentId: resolved.agentId,
    workspaceDir: resolved.workspaceDir,
  };
}

function writeResult(result: { record: unknown; revisionHash: string }) {
  return { record: result.record, revisionHash: result.revisionHash };
}

export const skillsExperienceHandlers: GatewayRequestHandlers = {
  "skills.experience.list": defineSkillsProposalWorkspaceHandler(
    "skills.experience.list",
    validateSkillExperienceListParams,
    async (_params, resolved) => await listExperiences(scope(resolved)),
  ),
  "skills.experience.read": defineSkillsProposalWorkspaceHandler(
    "skills.experience.read",
    validateSkillExperienceReadParams,
    async (params, resolved) => await readExperience(scope(resolved), params.id),
  ),
  "skills.experience.create": defineSkillsProposalWorkspaceHandler(
    "skills.experience.create",
    validateSkillExperienceCreateParams,
    async (params, resolved) => writeResult(await createExperience(scope(resolved), params)),
  ),
  "skills.experience.update": defineSkillsProposalWorkspaceHandler(
    "skills.experience.update",
    validateSkillExperienceUpdateParams,
    async (params, resolved) => writeResult(await updateExperience(scope(resolved), params)),
  ),
  "skills.experience.retire": defineSkillsProposalWorkspaceHandler(
    "skills.experience.retire",
    validateSkillExperienceRetireParams,
    async (params, resolved) => writeResult(await retireExperience(scope(resolved), params)),
  ),
  "skills.experience.restore": defineSkillsProposalWorkspaceHandler(
    "skills.experience.restore",
    validateSkillExperienceRestoreParams,
    async (params, resolved) => writeResult(await restoreExperience(scope(resolved), params)),
  ),
  "skills.experience.promote": defineSkillsProposalWorkspaceHandler(
    "skills.experience.promote",
    validateSkillExperiencePromoteParams,
    async (params, resolved) => {
      const result = await promoteExperience(scope(resolved), params);
      return {
        record: result.record,
        revisionHash: result.revisionHash,
        proposal: result.proposal,
      };
    },
  ),
};
