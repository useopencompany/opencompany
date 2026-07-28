import type { GoatHarnessSpec, goatTasks } from "@opencompany/db/goat-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import type { GoatTaskRunSink } from "./goat-harness";
import { runGoatTaskChatLoop } from "./goat-task-chat-loop";

const aiMock = vi.hoisted(() => ({
  streamText: vi.fn(),
  createGateway: vi.fn(() => (model: string) => ({ model })),
  stepCountIs: vi.fn((steps: number) => ({ steps })),
}));
const toolContextMock = vi.hoisted(() => ({
  createOpenCompanyChatToolContext: vi.fn(
    (_input: { updateTaskStatus?: (i: { status: string; comment: string }) => Promise<void> }) => ({
      tools: {} as Record<string, unknown>,
      repairToolCall: undefined,
    }),
  ),
  prepareOpenCompanyChatStep: vi.fn(() => ({})),
}));

vi.mock("ai", () => ({
  streamText: aiMock.streamText,
  createGateway: aiMock.createGateway,
  stepCountIs: aiMock.stepCountIs,
}));
vi.mock("@opencompany/observability/braintrust", () => ({
  getBraintrustAISDK: <T>(sdk: T) => sdk,
}));
vi.mock("@opencompany/goat-observability", () => ({
  GOAT_SPANS: { taskModelStream: "goat.task.model_stream" },
  withGoatSpan: <T>(_name: string, _attrs: unknown, run: () => Promise<T>) => run(),
  createGoatGatewayAttribution: () => ({}),
  goatGatewayProviderOptions: () => ({}),
  hashGoatUserId: () => "hash",
  recordGoatModelUsageTokens: () => {},
}));
vi.mock("@opencompany/goat-agent/chat-agent", () => toolContextMock);
vi.mock("@opencompany/goat-agent/prompts", () => ({
  createOpenCompanyChatSystemPrompt: () => "SYSTEM",
}));
vi.mock("@opencompany/goat-agent/actions/catalog", () => ({
  resolveGoatActionCatalog: vi.fn(async () => ({ providers: [], actions: [] })),
}));
vi.mock("@opencompany/goat-agent/actions/execute", () => ({ executeGoatAction: vi.fn() }));
vi.mock("@opencompany/goat-agent/chat-web-fetch", () => ({ executeGoatChatExaFetch: vi.fn() }));
vi.mock("@opencompany/goat-agent/chat-web-search", () => ({ executeGoatChatExaSearch: vi.fn() }));
// No brain resolves → the loop wires no runBrainCli and no actions, keeping the
// stream→sink mapping the whole focus of this test.
vi.mock("@opencompany/db/goat-workspaces", () => ({
  getDefaultGoatBrainForUser: vi.fn(async () => null),
  getGoatBrainAccess: vi.fn(async () => null),
}));
vi.mock("./db", () => ({ getDb: () => ({}) }));
vi.mock("./goat-codex-brain-tool", () => ({ runGoatTaskBrainRead: vi.fn() }));

type GoatTask = typeof goatTasks.$inferSelect;

const model = "moonshotai/kimi-k2.6" as never;
const harnessSpec: GoatHarnessSpec = {
  schemaVersion: "goat.harness.v1",
  engine: "opencompany",
  model,
  systemPrompt: "",
  initialUserMessage: "Do the thing.",
  tools: [],
  skills: [],
  maxModelSteps: 16,
  resultMode: "assistant_final",
};

beforeEach(() => {
  vi.clearAllMocks();
  toolContextMock.createOpenCompanyChatToolContext.mockReturnValue({
    tools: {},
    repairToolCall: undefined,
  });
  toolContextMock.prepareOpenCompanyChatStep.mockReturnValue({});
});

describe("runGoatTaskChatLoop", () => {
  it("maps the model fullStream onto the task sink (text, tool lifecycle, usage)", async () => {
    aiMock.streamText.mockReturnValueOnce({
      fullStream: streamParts(
        { type: "text-delta", text: "Working" },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "web_search",
          input: { query: "marseille" },
        },
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "web_search",
          input: { query: "marseille" },
          output: { ok: true },
        },
        {
          type: "finish-step",
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          response: { id: "resp_1", modelId: "m1", timestamp: new Date("2026-01-01T00:00:00Z") },
          finishReason: "stop",
        },
      ),
      text: Promise.resolve("Final answer."),
    });
    const sink = createSink();

    const result = await runGoatTaskChatLoop({
      env: env(),
      task: task(),
      harnessSpec,
      signal: new AbortController().signal,
      sink,
      assistantMessageId: "assistant_msg_1",
    });

    expect(result.assistantContent).toBe("Final answer.");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });

    expect(sink.updateMessageContent).toHaveBeenLastCalledWith({
      messageId: "assistant_msg_1",
      content: "Final answer.",
    });
    expect(sink.createToolMessage).toHaveBeenCalledWith({
      toolCallId: "call_1",
      toolName: "web_search",
      input: { query: "marseille" },
    });
    expect(sink.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool.started" }),
    );
    expect(sink.completeToolMessage).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "call_1", output: { ok: true } }),
    );
    expect(sink.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool.completed" }),
    );
    expect(sink.recordModelUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "assistant_msg_1",
        phase: "execution",
        stepIndex: 0,
        modelName: model,
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      }),
    );
  });

  it("captures the reported outcome from the injected update_task_status runner", async () => {
    // Simulate the model calling update_task_status by invoking the runner the
    // loop injects into createOpenCompanyChatToolContext.
    toolContextMock.createOpenCompanyChatToolContext.mockImplementationOnce(
      (input: { updateTaskStatus?: (i: { status: string; comment: string }) => Promise<void> }) => {
        // The injected runner sets the outcome synchronously (no await in its body).
        void input.updateTaskStatus?.({ status: "needs_attention", comment: "Needs review." });
        return { tools: {}, repairToolCall: undefined };
      },
    );
    aiMock.streamText.mockReturnValueOnce({
      fullStream: streamParts({
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
      text: Promise.resolve("Summary."),
    });

    const result = await runGoatTaskChatLoop({
      env: env(),
      task: task(),
      harnessSpec,
      signal: new AbortController().signal,
      sink: createSink(),
      assistantMessageId: "assistant_msg_1",
    });

    expect(result.reportedOutcome).toBe("needs_attention");
    expect(result.outcomeComment).toBe("Needs review.");
  });
});

async function* streamParts(...parts: Array<Record<string, unknown>>) {
  for (const part of parts) yield part;
}

function createSink(): GoatTaskRunSink {
  return {
    createAssistantMessage: vi.fn(async () => ({ id: "assistant_msg_1" })),
    updateMessageContent: vi.fn(async () => {}),
    completeMessage: vi.fn(async () => {}),
    failMessage: vi.fn(async () => {}),
    createToolMessage: vi.fn(async () => ({ id: "tool_msg_1" })),
    completeToolMessage: vi.fn(async () => {}),
    failToolMessage: vi.fn(async () => {}),
    appendEvent: vi.fn(async () => {}),
    recordModelUsage: vi.fn(async () => {}),
    recordToolUsage: vi.fn(async () => {}),
    recordSandboxUsage: vi.fn(async () => {}),
    updateCodexEngineSessionId: vi.fn(async () => {}),
  };
}

function task(overrides: Partial<GoatTask> = {}): GoatTask {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Research Marseille",
    userWorkosId: "user_1",
    prompt: "Do the thing.",
    model,
    scheduleId: null,
    scheduledFor: null,
    workflowId: null,
    workflowBrainRef: null,
    status: "running",
    stage: "running",
    result: null,
    error: null,
    reportedOutcome: null,
    outcomeComment: null,
    harnessSpec,
    debugTrace: {},
    codexEngineSessionId: null,
    sandboxId: null,
    attempts: 1,
    nextRunAt: now,
    leaseId: "lease_1",
    leaseOwner: "runner_1",
    leaseExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    vercelAiGatewayApiKey: "gateway",
    exaApiKey: undefined,
    instanceId: "runner_1",
    ...overrides,
  } as RunnerEnv;
}
