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

/** Strips the final path segment while preserving the original separator. */
export function skillInstructionDirectoryPath(filePath: string): string {
  const separator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return separator >= 0 ? filePath.slice(0, separator + 1) : "";
}
