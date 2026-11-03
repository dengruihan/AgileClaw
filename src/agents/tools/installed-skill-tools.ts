import { Type } from "typebox";
import {
  bindAgentToolAvailability,
  getAgentToolAvailabilityBinding,
  type AgentToolAvailabilityBinding,
} from "../agent-tool-availability.js";
import {
  readInstalledSkill,
  searchInstalledSkills,
  type InstalledSkill,
} from "../installed-skill-catalog.js";
import {
  asToolParamsRecord,
  jsonResult,
  readNumberParam,
  readToolStringParam,
  type AnyAgentTool,
} from "./common.js";

export function createInstalledSkillTools(skills: readonly InstalledSkill[]): AnyAgentTool[] {
  if (skills.length === 0) {
    return [];
  }
  const readerBinding: AgentToolAvailabilityBinding = { prepare() {} };
  let readAuthority: object | undefined;
  return [
    bindAgentToolAvailability<AnyAgentTool>(
      {
        name: "skills_search",
        label: "Search Installed Skills",
        description:
          "Find relevant installed, eligible skills and agent-private experiences by task or exact name, including documents omitted from the prompt directory. Searches names and descriptions, plus bounded instruction text when reads are allowed. Returns metadata only (`kind` distinguishes skill from experience); coverage reports any incomplete body indexing. Read the selected document's whole instructions before applying it. Does not search ClawHub or install anything.",
        parameters: Type.Object({
          query: Type.String({ minLength: 1, maxLength: 1000 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        }),
        execute: async (_id, args, signal) => {
          signal?.throwIfAborted();
          const params = asToolParamsRecord(args);
          const authority = readAuthority;
          return jsonResult(
            await searchInstalledSkills(
              skills,
              readToolStringParam(params, "query", { required: true }),
              readNumberParam(params, "limit"),
              signal,
              () => authority !== undefined && readAuthority === authority,
            ),
          );
        },
      },
      {
        prepare(_tool, callableTools) {
          const reader = callableTools.get("skills_read");
          if (reader && getAgentToolAvailabilityBinding(reader) === readerBinding) {
            readAuthority ??= {};
          } else {
            // A regrant gets a new identity; work started under a revoked grant stays revoked.
            readAuthority = undefined;
          }
        },
      },
    ),
    bindAgentToolAvailability<AnyAgentTool>(
      {
        name: "skills_read",
        label: "Read Installed Skill",
        description:
          "Load complete instructions (SKILL.md or agent-private EXPERIENCE.md) for an exact installed name. Use a known name directly; search is not required first. Does not execute the document or grant additional tool permissions.",
        parameters: Type.Object({ name: Type.String({ minLength: 1 }) }),
        execute: async (_id, args, signal) => {
          const params = asToolParamsRecord(args);
          const name = readToolStringParam(params, "name", { required: true });
          const content = await readInstalledSkill(skills, name, signal);
          return { content: [{ type: "text", text: content }], details: { name, content } };
        },
      },
      readerBinding,
    ),
  ];
}
