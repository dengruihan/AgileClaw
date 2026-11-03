/** Instruction document a discovery root loads and the identity it exposes. */
export type SkillDocumentKind = "skill" | "experience";

export const SKILL_INSTRUCTION_FILE = "SKILL.md";
export const EXPERIENCE_INSTRUCTION_FILE = "EXPERIENCE.md";

export function instructionFileForDocumentKind(kind: SkillDocumentKind | undefined): string {
  return kind === "experience" ? EXPERIENCE_INSTRUCTION_FILE : SKILL_INSTRUCTION_FILE;
}

export function documentKindForInstructionFile(fileName: string): SkillDocumentKind {
  return fileName === EXPERIENCE_INSTRUCTION_FILE ? "experience" : "skill";
}
