import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it.each([
    {
      locale: "en-US",
      documentLocale: "en",
      send: "Send message",
      waiting: "Waiting for a response",
      retryWaiting: "Service temporarily unavailable (HTTP 503) · Retry 1 · Waiting to retry",
      retryRequesting: "Retry 1 · Retrying",
      recovered: "Recovered",
      failure: "Authentication failed (HTTP 401) · Cannot retry",
    },
    {
      locale: "zh-CN",
      documentLocale: "zh-CN",
      send: "发送消息",
      waiting: "等待响应",
      retryWaiting: "服务暂时不可用 (HTTP 503) · 第 1 次重试 · 等待重试",
      retryRequesting: "第 1 次重试 · 正在重试",
      recovered: "已恢复",
      failure: "身份验证失败 (HTTP 401) · 不可重试",
    },
  ])("shows retry stages, recovery history, and final errors in $locale", async (copy) => {
    const context = await suite.newBrowserContext({
      ...createControlUiE2eContextOptions(),
      locale: copy.locale,
    });
    try {
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        historyMessages: [],
        agentModel: "openai/synthetic-model",
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await expect.poll(() => page.locator("html").getAttribute("lang")).toBe(copy.documentLocale);
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("Recover this model request");
      await page.getByRole("button", { name: copy.send }).click();
      const request = await gateway.waitForRequest("chat.send");
      const runId = requireString(requireRecord(request.params).idempotencyKey, "run id");
      const event = {
        runId,
        sessionKey: "agent:main:main",
        state: "status",
        phase: "starting_model",
      };
      await gateway.emitGatewayEvent("chat", { ...event, seq: 1 });
      await expect
        .poll(() => page.locator(".chat-working-indicator").textContent())
        .toContain(copy.waiting);
      await captureUiProof(suite, page, `retry-${copy.locale}`, "before-waiting.png");
      const status = {
        id: "retry-1",
        number: 1,
        stage: "waiting",
        reason: "server_error",
        status: 503,
        code: "UPSTREAM_BUSY",
        errorMessage: "Synthetic upstream diagnostic: temporarily unavailable",
        at: Date.now(),
      };
      await gateway.emitGatewayEvent("chat", { ...event, seq: 2, retry: { status } });
      await expect
        .poll(() => page.locator(".chat-working-indicator").textContent())
        .toContain(copy.retryWaiting);
      const elapsedStart = await page
        .locator("openclaw-elapsed-time")
        .first()
        .evaluate((element) => (element as HTMLElement & { startMs: number }).startMs);
      await page.locator(".chat-retry-details summary").click();
      await page
        .locator(".chat-retry-details pre")
        .filter({ hasText: status.errorMessage })
        .waitFor();
      await captureUiProof(suite, page, `retry-${copy.locale}`, "after-waiting.png");
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey: event.sessionKey,
        seq: 3,
        ts: status.at + 1,
        stream: "run_status",
        data: { phase: "retrying", retry: { ...status, stage: "requesting", at: status.at + 1 } },
      });
      await expect
        .poll(() => page.locator(".chat-working-indicator").textContent())
        .toContain(copy.retryRequesting);
      expect(
        await page
          .locator("openclaw-elapsed-time")
          .first()
          .evaluate((element) => (element as HTMLElement & { startMs: number }).startMs),
      ).toBe(elapsedStart);
      await gateway.emitGatewayEvent("chat", {
        ...event,
        state: "delta",
        message: { role: "assistant", content: "Partial response recovered" },
      });
      await page
        .locator(".chat-text")
        .getByText("Partial response recovered", { exact: true })
        .waitFor();
      await gateway.emitGatewayEvent("chat", { ...event, seq: 2, retry: { status } });
      expect(await page.locator(".chat-retry-details").count()).toBe(0);
      const terminal = { ...status, stage: "recovered", at: status.at + 2 };
      const records = [status, { ...status, stage: "requesting", at: status.at + 1 }, terminal].map(
        (details, index) => ({
          role: "custom",
          customType: "openclaw.model-retry",
          display: true,
          excludeFromContext: true,
          details,
          timestamp: details.at,
          content: "Retry",
          __openclaw: { id: `retry-entry-${index}`, seq: index + 2, runId },
        }),
      );
      const history = [
        {
          role: "user",
          content: "Recover this model request",
          timestamp: status.at - 10,
          __openclaw: { id: "request", seq: 1, runId },
        },
        ...records,
        {
          role: "assistant",
          content: "Recovery complete",
          timestamp: status.at + 3,
          __openclaw: { id: "answer", seq: 5, runId },
        },
      ];
      await gateway.setHistoryMessages(history);
      await gateway.emitChatFinal({ runId, text: "Recovery complete" });
      await page.locator(".chat-text").getByText("Recovery complete", { exact: true }).waitFor();
      const restored = await context.newPage();
      const restoredGateway = await installMockGateway(restored, {
        historyMessages: history,
        agentModel: "openai/synthetic-model",
      });
      await restored.goto(`${suite.server.baseUrl}chat`);
      await expect
        .poll(() => restored.locator("html").getAttribute("lang"))
        .toBe(copy.documentLocale);
      const historyPanel = restored.locator(".chat-retry-history > details");
      await historyPanel.locator("summary").first().waitFor();
      expect(await historyPanel.getAttribute("open")).toBeNull();
      await historyPanel.locator("summary").first().click();
      await expect
        .poll(() => restored.locator(".chat-retry-history__entries > li").count())
        .toBe(3);
      await expect.poll(() => historyPanel.textContent()).toContain(copy.recovered);
      await captureUiProof(suite, restored, `retry-${copy.locale}`, "after-history.png");
      await restored
        .locator(".agent-chat__composer-combobox textarea")
        .fill("Report a final model error");
      await restored.getByRole("button", { name: copy.send }).click();
      const failedRequest = await restoredGateway.waitForRequest("chat.send");
      const failedRunId = requireString(
        requireRecord(failedRequest.params).idempotencyKey,
        "failed run id",
      );
      const failure = {
        id: "failure-0",
        number: 0,
        stage: "failed",
        reason: "auth",
        status: 401,
        code: "AUTH_FAILED",
        errorMessage: "Synthetic credential diagnostic: access denied",
        stopReason: "non_retryable",
        at: status.at + 10,
      };
      await restoredGateway.emitGatewayEvent("chat", {
        ...event,
        runId: failedRunId,
        seq: 1,
        retry: { status: failure },
      });
      await restoredGateway.emitGatewayEvent("chat", {
        runId: failedRunId,
        sessionKey: event.sessionKey,
        state: "error",
        seq: 2,
        errorMessage: "Generic provider failure",
      });
      await expect
        .poll(() => restored.locator(".chat-error__summary strong").textContent())
        .toContain(copy.failure);
      await restored.locator(".chat-error__summary").click();
      await expect
        .poll(() => restored.locator(".chat-error").textContent())
        .toContain(failure.errorMessage);
      expect(await restored.locator(".chat-error__diagnostic").isVisible()).toBe(true);
      await captureUiProof(suite, restored, `retry-${copy.locale}`, "after-failure.png");
      console.log(`Retry proof: ${path.join(suite.artifactDir, `retry-${copy.locale}`)}`);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
