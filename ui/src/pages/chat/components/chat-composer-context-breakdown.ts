import type { SessionSystemPromptReport } from "../../../../../src/config/sessions/session-system-prompt-report.js";
import type { ToolsEffectiveResult } from "../../../api/types.ts";

const CHARS_PER_TOKEN = 4;

export type ContextUsageBreakdownRowId =
  | "systemTools"
  | "mcpTools"
  | "tools"
  | "systemPrompt"
  | "skills"
  | "other"
  | "messages";

export type ContextUsageBreakdownRow = {
  id: ContextUsageBreakdownRowId;
  tokens: number;
  /** Share of the used context, 0–100, rounded to one decimal. */
  percent: number;
};

export type ContextUsageBreakdown = {
  rows: ContextUsageBreakdownRow[];
  /** True when the tool catalog is unavailable and tools share a single row. */
  combinedTools: boolean;
};

function charsToTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function collectMcpToolNames(toolsEffective: ToolsEffectiveResult | null): Set<string> | null {
  if (!toolsEffective || !Array.isArray(toolsEffective.groups)) {
    return null;
  }
  const names = new Set<string>();
  for (const group of toolsEffective.groups) {
    for (const tool of group.tools ?? []) {
      if (tool.source === "mcp") {
        names.add(tool.id);
      }
    }
  }
  return names;
}

/**
 * Maps one session's system prompt report onto hover-card rows. Char-based
 * estimates are divided by the shared chars-per-token heuristic; the messages
 * row is the remainder of the provider-reported context snapshot, so rows stay
 * honest about their estimate nature instead of double-counting.
 */
export function buildContextUsageBreakdown(
  report: SessionSystemPromptReport,
  toolsEffective: ToolsEffectiveResult | null,
  usedTokens: number | null,
): ContextUsageBreakdown {
  const mcpToolNames = collectMcpToolNames(toolsEffective);
  let systemToolChars = 0;
  let mcpToolChars = 0;
  for (const entry of report.tools.entries) {
    const chars = entry.summaryChars + entry.schemaChars;
    if (mcpToolNames?.has(entry.name)) {
      mcpToolChars += chars;
    } else {
      systemToolChars += chars;
    }
  }
  // The tool list block advertises every tool, so split its overhead in
  // proportion to each side's schema share when the split is known.
  const entryCharsTotal = systemToolChars + mcpToolChars;
  if (mcpToolNames && entryCharsTotal > 0 && report.tools.listChars > 0) {
    const mcpShare = mcpToolChars / entryCharsTotal;
    mcpToolChars += report.tools.listChars * mcpShare;
    systemToolChars += report.tools.listChars * (1 - mcpShare);
  } else {
    systemToolChars += report.tools.listChars;
  }

  const filesChars = report.injectedWorkspaceFiles.reduce(
    (sum, file) => (file.injectionStatus === "native_unverified" ? sum : sum + file.injectedChars),
    0,
  );
  const runtimeChars =
    (report.currentTurn?.runtimeContextChars ?? 0) +
    (report.currentTurn?.modelOnlyPromptChars ?? 0);

  const toolRows: ContextUsageBreakdownRow[] = mcpToolNames
    ? [
        { id: "systemTools", tokens: charsToTokens(systemToolChars), percent: 0 },
        { id: "mcpTools", tokens: charsToTokens(mcpToolChars), percent: 0 },
      ]
    : [{ id: "tools", tokens: charsToTokens(systemToolChars), percent: 0 }];

  const staticRows: ContextUsageBreakdownRow[] = [
    ...toolRows,
    { id: "systemPrompt", tokens: charsToTokens(report.systemPrompt.chars), percent: 0 },
    { id: "skills", tokens: charsToTokens(report.skills.promptChars), percent: 0 },
    { id: "other", tokens: charsToTokens(filesChars + runtimeChars), percent: 0 },
  ];
  const estimateTotal = staticRows.reduce((sum, row) => sum + row.tokens, 0);
  const used =
    typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens > 0
      ? usedTokens
      : null;
  const rows: ContextUsageBreakdownRow[] =
    used === null
      ? staticRows
      : [...staticRows, { id: "messages", tokens: Math.max(0, used - estimateTotal), percent: 0 }];
  const denominator = Math.max(
    used ?? 0,
    rows.reduce((sum, row) => sum + row.tokens, 0),
  );
  for (const row of rows) {
    row.percent = denominator > 0 ? Math.round((row.tokens / denominator) * 1000) / 10 : 0;
  }
  return { rows, combinedTools: mcpToolNames === null };
}

/** One-decimal percent with the trailing ".0" trimmed, matching 70.7% / 0% display. */
export function formatContextUsagePercent(percent: number): string {
  const clamped = Math.min(Math.max(percent, 0), 100);
  return `${clamped.toFixed(1).replace(/\.0$/, "")}%`;
}
