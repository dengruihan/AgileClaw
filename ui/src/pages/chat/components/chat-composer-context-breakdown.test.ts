import { describe, expect, it } from "vitest";
import type { SessionSystemPromptReport } from "../../../../../src/config/sessions/session-system-prompt-report.js";
import type { ToolsEffectiveResult } from "../../../api/types.ts";
import {
  buildContextUsageBreakdown,
  formatContextUsagePercent,
} from "./chat-composer-context-breakdown.ts";

function reportFixture(
  overrides: Partial<SessionSystemPromptReport> = {},
): SessionSystemPromptReport {
  return {
    source: "run",
    generatedAt: 1,
    systemPrompt: { chars: 4_000, projectContextChars: 1_000, nonProjectContextChars: 3_000 },
    injectedWorkspaceFiles: [],
    skills: { promptChars: 1_200, entries: [] },
    tools: {
      listChars: 8_000,
      schemaChars: 0,
      entries: [
        { name: "bash", summaryChars: 2_000, schemaChars: 2_000 },
        { name: "mcp__db__query", summaryChars: 4_000, schemaChars: 8_000 },
      ],
    },
    ...overrides,
  };
}

function toolsFixture(): ToolsEffectiveResult {
  return {
    agentId: "main",
    profile: "full",
    groups: [
      {
        id: "core",
        label: "Core",
        source: "core",
        tools: [{ id: "bash", label: "bash", description: "", rawDescription: "", source: "core" }],
      },
      {
        id: "mcp",
        label: "MCP",
        source: "mcp",
        tools: [
          {
            id: "mcp__db__query",
            label: "query",
            description: "",
            rawDescription: "",
            source: "mcp",
            mcpServer: "db",
          },
        ],
      },
    ],
  };
}

function rowsById(breakdown: ReturnType<typeof buildContextUsageBreakdown>) {
  return new Map(breakdown.rows.map((row) => [row.id, row]));
}

describe("buildContextUsageBreakdown", () => {
  it("splits tools by catalog source and shares the tool list block proportionally", () => {
    const breakdown = buildContextUsageBreakdown(reportFixture(), toolsFixture(), 10_000);
    const rows = rowsById(breakdown);
    // 4k entry chars for bash + 2k of the 8k list block; chars/4.
    expect(rows.get("systemTools")?.tokens).toBe(1_500);
    // 12k entry chars for the MCP tool + 6k of the list block.
    expect(rows.get("mcpTools")?.tokens).toBe(4_500);
    expect(rows.get("systemPrompt")?.tokens).toBe(1_000);
    expect(rows.get("skills")?.tokens).toBe(300);
    expect(rows.get("other")?.tokens).toBe(0);
    // Provider-reported usage minus the estimates is the message history.
    expect(rows.get("messages")?.tokens).toBe(2_700);
    expect(breakdown.combinedTools).toBe(false);
    // Rows read highest share first.
    expect(breakdown.rows.map((row) => row.id)).toEqual([
      "mcpTools",
      "messages",
      "systemTools",
      "systemPrompt",
      "skills",
      "other",
    ]);
  });

  it("keeps catalog-unknown report tools on the system side", () => {
    const report = reportFixture({
      tools: {
        listChars: 0,
        schemaChars: 0,
        entries: [{ name: "retired_tool", summaryChars: 400, schemaChars: 400 }],
      },
    });
    const rows = rowsById(buildContextUsageBreakdown(report, toolsFixture(), 10_000));
    expect(rows.get("systemTools")?.tokens).toBe(200);
    expect(rows.has("mcpTools")).toBe(true);
    expect(rows.get("mcpTools")?.tokens).toBe(0);
  });

  it("falls back to one combined tools row without a catalog", () => {
    const breakdown = buildContextUsageBreakdown(reportFixture(), null, 10_000);
    const rows = rowsById(breakdown);
    expect(breakdown.combinedTools).toBe(true);
    expect(rows.has("systemTools")).toBe(false);
    expect(rows.has("mcpTools")).toBe(false);
    // All entry chars plus the full list block in one bucket.
    expect(rows.get("tools")?.tokens).toBe(6_000);
  });

  it("clamps the messages remainder at zero and normalizes by the estimate sum", () => {
    const breakdown = buildContextUsageBreakdown(reportFixture(), toolsFixture(), 100);
    const rows = rowsById(breakdown);
    expect(rows.get("messages")?.tokens).toBe(0);
    // denominator falls back to the estimate total (7.3k), not the tiny usage.
    expect(rows.get("mcpTools")?.percent).toBeCloseTo(61.6, 1);
  });

  it("omits the messages row when the context snapshot is missing", () => {
    const breakdown = buildContextUsageBreakdown(reportFixture(), toolsFixture(), null);
    expect(breakdown.rows.some((row) => row.id === "messages")).toBe(false);
    expect(rowsById(breakdown).get("mcpTools")?.percent).toBeCloseTo(61.6, 1);
  });

  it("counts verified injected files and runtime context under other", () => {
    const report = reportFixture({
      currentTurn: { promptChars: 900, runtimeContextChars: 500, modelOnlyPromptChars: 100 },
      injectedWorkspaceFiles: [
        {
          name: "AGENTS.md",
          path: "AGENTS.md",
          missing: false,
          rawChars: 2_000,
          injectionStatus: "verified",
          injectedChars: 1_600,
          truncated: false,
        },
        {
          name: "native.md",
          path: "native.md",
          missing: false,
          rawChars: 1_000,
          injectionStatus: "native_unverified",
          injectedChars: null,
          truncated: null,
        },
      ],
    });
    const rows = rowsById(buildContextUsageBreakdown(report, toolsFixture(), 10_000));
    // files 1.6k + runtime 500 + model-only 100, all ÷4.
    expect(rows.get("other")?.tokens).toBe(550);
    expect(rows.get("messages")?.tokens).toBe(2_150);
  });
});

describe("formatContextUsagePercent", () => {
  it("formats one decimal and trims the trailing zero", () => {
    expect(formatContextUsagePercent(70.7)).toBe("70.7%");
    expect(formatContextUsagePercent(0)).toBe("0%");
    expect(formatContextUsagePercent(4)).toBe("4%");
    expect(formatContextUsagePercent(100)).toBe("100%");
    expect(formatContextUsagePercent(-3)).toBe("0%");
    expect(formatContextUsagePercent(120)).toBe("100%");
  });
});
