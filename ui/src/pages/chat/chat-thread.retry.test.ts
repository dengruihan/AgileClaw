// @vitest-environment node
import { expect, it } from "vitest";
import { buildChatItems } from "./chat-thread-build.ts";
import { createProps } from "./chat-thread.test-support.ts";

it("projects ordered retry records once per run and updates their retained terminal outcome", () => {
  const status = {
    id: "retry-a",
    number: 1,
    stage: "waiting",
    reason: "server_error",
    status: 503,
    errorMessage: "Temporary upstream failure",
    at: 200,
  };
  const record = (runId: string, details: unknown) => ({
    role: "custom",
    customType: "openclaw.model-retry",
    details,
    display: true,
    excludeFromContext: true,
    content: "Retry",
    timestamp: 200,
    __openclaw: { runId },
  });
  const messages = [
    { role: "user", content: "First request", timestamp: 100 },
    record("a", status),
    record("a", status),
    { role: "assistant", content: "Partial answer", timestamp: 250 },
    { role: "user", content: "Second request", timestamp: 300 },
    record("b", { ...status, id: "retry-b", at: 400 }),
  ];
  const project = (history: unknown[]) =>
    buildChatItems(createProps({ messages: history })).filter((item) => item.kind === "notice");
  expect(project(messages)).toMatchObject([
    { key: "model-retry:a", label: "Retry history (1)", retryHistory: [{ stage: "waiting" }] },
    { key: "model-retry:b", label: "Retry history (1)", retryHistory: [{ stage: "waiting" }] },
  ]);
  const updated = project([...messages, record("a", { ...status, stage: "recovered", at: 500 })]);
  expect(updated[0]?.retryHistory).toHaveLength(2);
  expect(updated[0]?.retryHistory?.[1]).toMatchObject({ stage: "recovered" });
  expect(updated[1]?.retryHistory).toHaveLength(1);
});
