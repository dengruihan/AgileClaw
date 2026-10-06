import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
// Lmstudio tests cover stream plugin behavior.
import { createRequireRecord, createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import { wrapLmstudioInference } from "./stream.js";

let defaultBaseUrl: string;
let defaultBaseUrlSequence = 0;

type StreamEvent = { type: string } & Record<string, unknown>;

const requireRecord = createRequireRecord("record", "expected-label-record");

function lmstudioAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant" as const,
    content,
    api: "openai-completions" as const,
    provider: "lmstudio",
    model: "qwen3-8b-instruct",
    usage: createZeroUsageFixture(),
    stopReason: "stop" as const,
    timestamp: 1,
  };
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectSingleDoneEvent(events: StreamEvent[]) {
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("done");
}

function requireMockCallArg(mock: { mock: { calls: unknown[][] } }, label: string) {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

function expectBaseStreamModelFields(baseStream: StreamFn, fields: Record<string, unknown>) {
  const call = requireMockCallArg(
    baseStream as unknown as { mock: { calls: unknown[][] } },
    "base stream",
  );
  expectRecordFields(requireRecord(call[0], "base stream model"), fields);
  if (call[1] === undefined) {
    throw new Error("Expected base stream context");
  }
  expect(call[2]).toBeUndefined();
}

async function collectEvents(stream: ReturnType<StreamFn>): Promise<StreamEvent[]> {
  const resolved = stream instanceof Promise ? await stream : stream;
  const events: StreamEvent[] = [];
  for await (const event of resolved) {
    events.push(event as StreamEvent);
  }
  return events;
}

function buildDoneStreamFn(): StreamFn {
  return vi.fn((_model, _context, _options) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message: lmstudioAssistantMessage([]) });
      stream.end();
    });
    return stream;
  });
}

function buildEventStreamFn(events: unknown[]): StreamFn {
  return vi.fn((_model, _context, _options) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      for (const event of events) {
        stream.push(event as never);
      }
      stream.end();
    });
    return stream;
  });
}

function createWrappedLmstudioStream(
  baseStream: StreamFn,
  params?: { baseUrl?: string; thinkingLevel?: string },
): StreamFn {
  return wrapLmstudioInference({
    provider: "lmstudio",
    modelId: "qwen3-8b-instruct",
    config: createModelProviderConfig({
      lmstudio: {
        baseUrl: params?.baseUrl ?? defaultBaseUrl,
        models: [],
      },
    }),
    streamFn: baseStream,
    thinkingLevel: params?.thinkingLevel,
  } as never);
}

function buildPayloadStreamFn(payload: Record<string, unknown>): StreamFn {
  return vi.fn((model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      options?.onPayload?.(payload, model);
      stream.push({ type: "done", reason: "stop", message: {} as never });
      stream.end();
    });
    return stream;
  });
}

const BINARY_REASONING_COMPAT = {
  supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
  reasoningEffortMap: { off: "none", none: "none", adaptive: "xhigh", max: "xhigh" },
};

function runWrappedLmstudioStream(
  wrapped: StreamFn,
  model: Record<string, unknown>,
  options?: Record<string, unknown>,
  context?: Record<string, unknown>,
) {
  return wrapped(
    {
      provider: "lmstudio",
      api: "openai-completions",
      id: "lmstudio/qwen3-8b-instruct",
      ...model,
    } as never,
    { messages: [], ...context } as never,
    options as never,
  );
}

describe("lmstudio stream wrapper", () => {
  beforeEach(() => {
    defaultBaseUrl = `http://lmstudio-test-${defaultBaseUrlSequence++}.localhost:1234`;
  });

  it("marks regex tool patterns as unsupported before LM Studio inference", async () => {
    const baseStream = buildDoneStreamFn();
    const wrapped = createWrappedLmstudioStream(baseStream);

    expectSingleDoneEvent(await collectEvents(runWrappedLmstudioStream(wrapped, {})));

    const [model] = requireMockCallArg(
      baseStream as unknown as { mock: { calls: unknown[][] } },
      "base stream",
    );
    expectRecordFields(requireRecord(requireRecord(model, "base stream model").compat, "compat"), {
      supportsUsageInStreaming: true,
      unsupportedToolSchemaKeywords: ["pattern"],
    });
  });

  it("preserves and deduplicates configured unsupported tool-schema keywords", async () => {
    const baseStream = buildDoneStreamFn();
    const wrapped = createWrappedLmstudioStream(baseStream);
    const originalCompat = {
      supportsDeveloperRole: false,
      unsupportedToolSchemaKeywords: ["format", "pattern", "minimum", "pattern"],
    };

    expectSingleDoneEvent(
      await collectEvents(runWrappedLmstudioStream(wrapped, { compat: originalCompat })),
    );

    const [model] = requireMockCallArg(
      baseStream as unknown as { mock: { calls: unknown[][] } },
      "base stream",
    );
    expectRecordFields(requireRecord(requireRecord(model, "base stream model").compat, "compat"), {
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      unsupportedToolSchemaKeywords: ["format", "pattern", "minimum"],
    });
    expect(originalCompat).toEqual({
      supportsDeveloperRole: false,
      unsupportedToolSchemaKeywords: ["format", "pattern", "minimum", "pattern"],
    });
  });

  it("applies regex tool-schema compatibility alongside configured keywords", async () => {
    const baseStream = buildDoneStreamFn();
    const wrapped = createWrappedLmstudioStream(baseStream);

    expectSingleDoneEvent(
      await collectEvents(
        runWrappedLmstudioStream(wrapped, {
          id: "qwen3-8b-instruct",
          compat: { unsupportedToolSchemaKeywords: ["format"] },
        }),
      ),
    );

    expect(baseStream).toHaveBeenCalledTimes(1);
    const [model] = requireMockCallArg(
      baseStream as unknown as { mock: { calls: unknown[][] } },
      "base stream",
    );
    expectRecordFields(requireRecord(requireRecord(model, "base stream model").compat, "compat"), {
      supportsUsageInStreaming: true,
      unsupportedToolSchemaKeywords: ["format", "pattern"],
    });
  });

  it("promotes standalone bracketed local-model tool text to a structured tool call", async () => {
    const rawToolText = [
      "[mempalace_mempalace_search]",
      '{"query":"codename","wing":"personal","room":"identities"}',
      "[END_TOOL_REQUEST]",
    ].join("\n");
    const baseStream = buildEventStreamFn([
      { type: "start", partial: lmstudioAssistantMessage([]) },
      {
        type: "text_start",
        contentIndex: 0,
        partial: lmstudioAssistantMessage([{ type: "text", text: "" }]),
      },
      { type: "text_delta", contentIndex: 0, delta: rawToolText },
      { type: "text_end", contentIndex: 0, content: rawToolText },
      {
        type: "done",
        reason: "stop",
        message: lmstudioAssistantMessage([{ type: "text", text: rawToolText }]),
      },
    ]);
    const wrapped = createWrappedLmstudioStream(baseStream);
    const events = await collectEvents(
      runWrappedLmstudioStream(wrapped, {}, undefined, {
        tools: [
          {
            name: "mempalace_mempalace_search",
            description: "Search MemPalace",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const done = events.find((event) => event.type === "done") as {
      message?: { content?: Array<Record<string, unknown>>; stopReason?: string };
      reason?: string;
    };
    expect(done.reason).toBe("toolUse");
    expect(done.message?.stopReason).toBe("toolUse");
    const toolCall = requireRecord(done.message?.content?.[0], "tool call content");
    expectRecordFields(toolCall, {
      type: "toolCall",
      name: "mempalace_mempalace_search",
      arguments: { query: "codename", wing: "personal", room: "identities" },
    });
    expect(String(toolCall.id)).toMatch(/^call_[a-f0-9]{24}$/);
  });

  it("rewrites reasoning_effort to the disabled effort when thinking is off", async () => {
    const payload: Record<string, unknown> = {
      model: "qwen3-8b-instruct",
      reasoning_effort: "high",
    };
    const baseStream = buildPayloadStreamFn(payload);
    const wrapped = createWrappedLmstudioStream(baseStream, { thinkingLevel: "off" });
    const events = await collectEvents(
      runWrappedLmstudioStream(wrapped, { compat: BINARY_REASONING_COMPAT }),
    );

    expectSingleDoneEvent(events);
    expect(payload.reasoning_effort).toBe("none");
  });
});
