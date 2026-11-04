import { decodeSkillXml } from "./skill-contract.js";

const SKILL_NAME_PATTERN = /^[ ]{4}<name>(.*)<\/name>$/mu;
const SKILL_KIND_PATTERN = /^[ ]{4}<kind>(.*)<\/kind>$/mu;
const SKILL_LOCATION_PATTERN = /^[ ]{4}<location>(.*)<\/location>$/mu;

function readSkillField(block: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(block)?.[1];
  return match === undefined ? undefined : decodeSkillXml(match);
}

/** Reads identities from the canonical rendered catalog, excluding informational notes. */
export function parseSkillsPromptCatalog(prompt: string): {
  name: string;
  location: string;
  kind: "skill" | "experience";
}[] {
  const catalog = /<available_skills>\n([\s\S]*?)\n<\/available_skills>/u.exec(prompt)?.[1];
  if (!catalog) {
    return [];
  }
  const result: { name: string; location: string; kind: "skill" | "experience" }[] = [];
  for (const match of catalog.matchAll(/^[ ]{2}<skill>\n([\s\S]*?)\n[ ]{2}<\/skill>$/gmu)) {
    const block = match[1] ?? "";
    const name = readSkillField(block, SKILL_NAME_PATTERN);
    const location = readSkillField(block, SKILL_LOCATION_PATTERN);
    if (name && location) {
      result.push({
        name,
        location,
        kind: readSkillField(block, SKILL_KIND_PATTERN) === "experience" ? "experience" : "skill",
      });
    }
  }
  return result;
}
