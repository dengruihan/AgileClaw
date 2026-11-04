import fs from "node:fs/promises";
import path from "node:path";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { applyLoggingConfig, resetLogger } from "../../logging/logger.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import { createHostWorkspaceWriteTool, createOpenClawReadTool } from "../agent-tools.read.js";
import { resolveBootstrapContextForRun } from "../bootstrap-files.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { buildAgentSystemPrompt } from "../system-prompt.js";
import {
  createAssistant,
  createAssistantResultStream,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import type { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { createReadTool } from "./tools/read.js";

registerAgentSessionLoopTestLifecycle();
const sessions: AgentSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.dispose();
  }
});
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    cleanup();
  }),
);
afterEach(resetSecretRedactionRegistryForTest);
afterEach(resetLogger);

it("keeps registered user content through workspace writes, reads, bootstrap, and reopened history when off", async () => {
  const cwd = tempDirs.make("openclaw-workspace-redaction-off-");
  const scope = {
    agentId: "main",
    sessionId: "workspace-redaction-off",
    sessionKey: "agent:main:workspace-redaction-off",
    storePath: path.join(cwd, "openclaw-agent.sqlite"),
  };
  const config = { logging: { redact: "off" as const } };
  const phone = "13900000000";
  const content = `# Contact\n手机号：${phone}\n`;
  const input = `把我的手机号 ${phone} 写入 AGENTS.md 和 USER.md，然后读取确认。`;
  applyLoggingConfig(config.logging);
  registerSecretValueForRedaction(phone);
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = guardSessionManager(await SessionManager.openAsync(scope, cwd), { config });
  const customTools = toToolDefinitions([
    createHostWorkspaceWriteTool(cwd),
    createOpenClawReadTool(createReadTool(cwd), { cwd }),
  ]);
  const contexts: Context[] = [];
  streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
    contexts.push({
      systemPrompt: context.systemPrompt,
      messages: structuredClone(context.messages),
    });
    const step = contexts.length;
    return createAssistantResultStream(
      createAssistant(
        model,
        step <= 2
          ? ["AGENTS.md", "USER.md"].map((filename) => ({
              type: "toolCall" as const,
              id: `${step}-${filename}`,
              name: step === 1 ? "write" : "read",
              arguments: { path: filename, ...(step === 1 ? { content } : {}) },
            }))
          : [{ type: "text", text: `Confirmed ${phone}` }],
        step <= 2 ? "toolUse" : "stop",
      ),
    );
  });
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(testModel.provider, "synthetic-probe-auth");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(testModel.provider, {
    api: testModel.api,
    streamSimple: streamMocks.streamSimple,
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const initialResources = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager });
  await initialResources.reload();
  const options = {
    cwd,
    agentDir: cwd,
    model: testModel,
    thinkingLevel: "off" as const,
    authStorage,
    modelRegistry,
    tools: ["write", "read"],
    customTools,
    settingsManager,
  };
  const { session } = await createAgentSession({
    ...options,
    sessionManager: manager,
    resourceLoader: initialResources,
  });
  sessions.push(session);
  await session.prompt(input);
  expect(session.agent.state.errorMessage).toBeUndefined();
  expect(contexts).toHaveLength(3);
  expect(JSON.stringify(contexts[0]?.messages)).toContain(input);
  for (const result of contexts[1]?.messages.filter((message) => message.role === "toolResult") ??
    []) {
    expect(result, JSON.stringify(result)).toHaveProperty("isError", false);
  }
  const readResults = contexts[2]?.messages.filter(
    (message) => message.role === "toolResult" && message.toolName === "read",
  );
  expect(readResults).toHaveLength(2);
  for (const result of readResults ?? []) {
    expect(result, JSON.stringify(result)).toHaveProperty("isError", false);
    expect(JSON.stringify(result)).toContain(phone);
  }
  for (const filename of ["AGENTS.md", "USER.md"]) {
    expect(await fs.readFile(path.join(cwd, filename), "utf8")).toBe(content);
  }
  const stored = await loadTranscriptEvents(scope);
  expect(JSON.stringify(stored)).toContain(input);
  expect(JSON.stringify(stored)).toContain(`Confirmed ${phone}`);
  session.dispose();

  const { contextFiles } = await resolveBootstrapContextForRun({ workspaceDir: cwd, config });
  for (const filename of ["AGENTS.md", "USER.md"]) {
    expect(contextFiles.find((file) => path.basename(file.path) === filename)?.content).toBe(
      content.trimEnd(),
    );
  }
  const systemPrompt = buildAgentSystemPrompt({ workspaceDir: cwd, contextFiles });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    appendSystemPromptTransform: () => [systemPrompt],
  });
  await resourceLoader.reload();
  const reopened = guardSessionManager(await SessionManager.openAsync(scope, cwd), { config });
  const { session: restored } = await createAgentSession({
    ...options,
    sessionManager: reopened,
    resourceLoader,
  });
  sessions.push(restored);
  await restored.prompt("确认此前的联系方式。");
  expect(contexts).toHaveLength(4);
  expect(contexts[3]?.systemPrompt).toContain(content.trimEnd());
  expect(JSON.stringify(contexts[3]?.messages)).toContain(input);
  expect(JSON.stringify(contexts[3]?.messages)).toContain(phone);
  expect(await loadTranscriptEvents(scope)).toEqual(expect.arrayContaining(stored));
});
