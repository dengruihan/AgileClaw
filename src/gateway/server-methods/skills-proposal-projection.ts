import { PROPOSAL_DRAFT_FILE } from "../../skills/workshop/store-record.js";
import type { SkillProposalRecord } from "../../skills/workshop/types.js";

/** Projects an internally versioned draft path onto the public protocol shape. */
export function projectGatewaySkillProposalRecord(
  record: SkillProposalRecord,
): SkillProposalRecord {
  return record.draftFile === PROPOSAL_DRAFT_FILE
    ? record
    : { ...record, draftFile: PROPOSAL_DRAFT_FILE };
}
