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
  TASK_SYSTEM_BLOCK: "<background_task_run />",
  createOpenCompanyChatToolContext: vi.fn(
    (_input: { updateTaskStatus?: (i: { status: string; comment: string }) => Promise<void> }) => ({
      tools: {} as Record<string, unknown>,
      repairToolCall: undefined,
    }),
  ),
  prepareOpenCompanyChatStep: vi.fn(() => ({})),
}));
const workspaceMock = vi.hoisted(() => ({
  getDefaultGoatBrainForUser: vi.fn(async () => null),
  getGoatBrainAccess: vi.fn(async () => null),
  getGoatWorkspaceRole: vi.fn<() => Promise<"admin" | "member" | null>>(async () => null),
  listAccessibleGoatBrains: vi.fn(async () => []),
}));
const actionCatalogMock = vi.hoisted(() => ({
  resolveGoatActionCatalog: vi.fn(async () => ({ providers: [], actions: [] })),
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
vi.mock("@opencompany/goat-agent/actions/catalog", () => actionCatalogMock);
vi.mock("@opencompany/goat-agent/actions/execute", () => ({ executeGoatAction: vi.fn() }));
vi.mock("@opencompany/goat-agent/chat-web-fetch", () => ({ executeGoatChatExaFetch: vi.fn() }));
vi.mock("@opencompany/goat-agent/chat-web-search", () => ({ executeGoatChatExaSearch: vi.fn() }));
// No brain resolves → the loop wires no runBrainCli and no actions, keeping the
// stream→sink mapping the whole focus of this test.
vi.mock("@opencompany/db/goat-workspaces", () => ({
  DEFAULT_GOAT_BRAIN_SLUG: "general",
  ...workspaceMock,
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
  workspaceMock.getDefaultGoatBrainForUser.mockResolvedValue(null);
  workspaceMock.getGoatBrainAccess.mockResolvedValue(null);
  workspaceMock.getGoatWorkspaceRole.mockResolvedValue(null);
  workspaceMock.listAccessibleGoatBrains.mockResolvedValue([]);
  actionCatalogMock.resolveGoatActionCatalog.mockResolvedValue({ providers: [], actions: [] });
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

  it("does not expose task outcome reporting to the execution model", async () => {
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

    expect(result).toEqual({
      assistantContent: "Summary.",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    expect(toolContextMock.createOpenCompanyChatToolContext).toHaveBeenCalledWith(
      expect.not.objectContaining({ updateTaskStatus: expect.any(Function) }),
    );
  });

  it("replays prior task turns and treats the latest reply as the active user message", async () => {
    aiMock.streamText.mockReturnValueOnce({
      fullStream: streamParts({
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
      text: Promise.resolve("Afternoon is clear too."),
    });

    await runGoatTaskChatLoop({
      env: env(),
      task: task(),
      harnessSpec,
      conversationMessages: [
        { role: "user", content: "Original stored task prompt." },
        { role: "assistant", content: "Morning is clear." },
        { role: "user", content: "Check the afternoon too." },
      ],
      signal: new AbortController().signal,
      sink: createSink(),
      assistantMessageId: "assistant_msg_2",
    });

    expect(aiMock.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "user", content: "Do the thing." },
          { role: "assistant", content: "Morning is clear." },
          { role: "user", content: "Check the afternoon too." },
        ],
      }),
    );
    expect(toolContextMock.createOpenCompanyChatToolContext).toHaveBeenCalledWith(
      expect.objectContaining({ latestUserMessage: "Check the afternoon too." }),
    );
  });

  it("binds workflow tools to the workspace persisted in the harness spec", async () => {
    workspaceMock.getGoatWorkspaceRole.mockResolvedValue("member");
    workspaceMock.listAccessibleGoatBrains.mockResolvedValue([
      {
        id: "brain_target",
        workspaceId: "workspace_target",
        slug: "general",
        name: "General",
      } as never,
    ]);
    aiMock.streamText.mockReturnValueOnce({
      fullStream: streamParts({
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
      text: Promise.resolve("Summary."),
    });
    const workflowHarnessSpec: GoatHarnessSpec = {
      ...harnessSpec,
      workflow: {
        id: "launch-brief",
        workspaceId: "workspace_target",
        skillIds: [],
      },
    };

    await runGoatTaskChatLoop({
      env: env(),
      task: task({ workflowId: "launch-brief", harnessSpec: workflowHarnessSpec }),
      harnessSpec: workflowHarnessSpec,
      signal: new AbortController().signal,
      sink: createSink(),
      assistantMessageId: "assistant_msg_1",
    });

    expect(workspaceMock.listAccessibleGoatBrains).toHaveBeenCalledWith(
      { userWorkosId: "user_1", workspaceId: "workspace_target" },
      { db: {} },
    );
    expect(actionCatalogMock.resolveGoatActionCatalog).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_target",
    });
    expect(workspaceMock.getDefaultGoatBrainForUser).not.toHaveBeenCalled();
  });

  it("stops a workflow task when workspace access has been revoked", async () => {
    const workflowHarnessSpec: GoatHarnessSpec = {
      ...harnessSpec,
      workflow: {
        id: "launch-brief",
        workspaceId: "workspace_target",
        skillIds: [],
      },
    };

    await expect(
      runGoatTaskChatLoop({
        env: env(),
        task: task({ workflowId: "launch-brief", harnessSpec: workflowHarnessSpec }),
        harnessSpec: workflowHarnessSpec,
        signal: new AbortController().signal,
        sink: createSink(),
        assistantMessageId: "assistant_msg_1",
      }),
    ).rejects.toThrow("no longer have access");

    expect(actionCatalogMock.resolveGoatActionCatalog).not.toHaveBeenCalled();
    expect(aiMock.streamText).not.toHaveBeenCalled();
  });
});

async function* streamParts(...parts: Array<Record<string, unknown>>) {
  for (const part of parts) yield part;
}

function createSink(): GoatTaskRunSink {
  return {
    createUserMessage: vi.fn(async () => ({ id: "user_msg_2" })),
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
    sessionId: null,
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
