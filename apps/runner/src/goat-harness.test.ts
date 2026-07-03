import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { GoatHarnessSpec, goatTasks } from "@opencompany/db/goat-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import { executeGoatTask, type GoatTaskRunSink, planGoatHarness } from "./goat-harness";
import { GOAT_HARNESS_CREATION_SYSTEM_PROMPT } from "./prompts/goat-harness-creation";
import { GOAT_TASK_HARNESS_SYSTEM_PROMPT } from "./prompts/goat-task-harness";

const aiMock = vi.hoisted(() => ({
  generateObject: vi.fn(),
  streamText: vi.fn(),
  createGateway: vi.fn(() => (model: string) => ({ model })),
  jsonSchema: vi.fn((schema: unknown) => schema),
  stepCountIs: vi.fn((steps: number) => ({ steps })),
  tool: vi.fn((definition: unknown) => definition),
}));

vi.mock("ai", () => ({
  generateObject: aiMock.generateObject,
  streamText: aiMock.streamText,
  createGateway: aiMock.createGateway,
  jsonSchema: aiMock.jsonSchema,
  stepCountIs: aiMock.stepCountIs,
  tool: aiMock.tool,
}));

vi.mock("@opencompany/observability/braintrust", () => ({
  getBraintrustAISDK: <T>(sdk: T) => sdk,
}));

type GoatTask = typeof goatTasks.$inferSelect;

const model = "openai/gpt-5.4-mini" as AgentModelId;
const harnessSpec: GoatHarnessSpec = {
  schemaVersion: "goat.harness.v1",
  model,
  systemPrompt: "Use read-only tools and answer directly.",
  initialUserMessage: "Research Marseille.",
  tools: ["exa_search"],
  maxModelSteps: 8,
  resultMode: "assistant_final",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planGoatHarness", () => {
  it("produces goat.harness.v1 with operation-level tools and keeps the selected model", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        model: "some-other-model",
        systemPrompt: "Use Gmail.",
        initialUserMessage: "Use Gmail to summarize the latest emails.",
        tools: ["gmail_search", "shell", "goat_result"],
        maxModelSteps: 12,
        resultMode: "assistant_final",
      },
    });

    await expect(
      planGoatHarness({
        prompt:
          "Summarize the user's latest emails. Since no inbox access is available in chat, ask the user to paste/export them.",
        model,
        availableTools: ["exa_search", "gmail_search"],
        gatewayApiKey: "gateway",
      }),
    ).resolves.toEqual({
      schemaVersion: "goat.harness.v1",
      model,
      systemPrompt: "Use Gmail.",
      initialUserMessage: "Use Gmail to summarize the latest emails.",
      tools: ["gmail_search"],
      maxModelSteps: 12,
      resultMode: "assistant_final",
    });

    expect(aiMock.generateObject).toHaveBeenCalledTimes(1);
    const request = aiMock.generateObject.mock.calls[0]?.[0] as {
      schema: Record<string, unknown>;
      system: string;
      prompt: string;
    };
    expect(request.system).toBe(GOAT_HARNESS_CREATION_SYSTEM_PROMPT);
    expect(request.system).toContain("<tool_policy>");
    expect(request.system).toContain("<result_contract>");
    expect(request.system).toContain("there is no final-result tool");
    expect(request.prompt).toContain("Available operation tools: exa_search, gmail_search");
    expect(request.prompt).toContain("no inbox access is available in chat");
  });

  it("defaults max steps and keeps at least exa_search when planner returns no valid tools", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        model,
        systemPrompt: "",
        initialUserMessage: "",
        tools: ["goat_result"],
        resultMode: "assistant_final",
      },
    });

    const result = await planGoatHarness({
      prompt: "Research Marseille.",
      model,
      availableTools: ["exa_search"],
      gatewayApiKey: "gateway",
    });

    expect(result).toMatchObject({
      schemaVersion: "goat.harness.v1",
      model,
      initialUserMessage: "Research Marseille.",
      tools: ["exa_search"],
      maxModelSteps: 8,
      resultMode: "assistant_final",
    });
    expect(result.systemPrompt).toBe(GOAT_TASK_HARNESS_SYSTEM_PROMPT);
  });

  it("keeps Linear MCP meta-tools when they are available", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        model,
        systemPrompt: "Use Linear MCP when relevant.",
        initialUserMessage: "Find my Linear issues about onboarding.",
        tools: ["linear_search_tools", "linear_use_tool"],
        maxModelSteps: 8,
        resultMode: "assistant_final",
      },
    });

    await expect(
      planGoatHarness({
        prompt: "Find my Linear issues about onboarding.",
        model,
        availableTools: ["exa_search", "linear_search_tools", "linear_use_tool"],
        gatewayApiKey: "gateway",
      }),
    ).resolves.toMatchObject({
      tools: ["linear_search_tools", "linear_use_tool"],
    });
  });
});

describe("executeGoatTask", () => {
  it("persists assistant content and returns final assistant text as the result", async () => {
    aiMock.generateObject.mockResolvedValueOnce({ object: harnessSpec });
    aiMock.streamText.mockReturnValueOnce({
      fullStream: streamParts(
        { type: "text-delta", text: "Done" },
        { type: "text-delta", text: "." },
        { type: "finish-step", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
      ),
      text: Promise.resolve("Done."),
    });
    const sink = createSink();

    await expect(
      executeGoatTask({
        task: task(),
        env: env(),
        signal: new AbortController().signal,
        sink,
        reportStage: vi.fn(async () => {}),
      }),
    ).resolves.toEqual({
      result: "Done.",
      harnessSpec,
      debugTrace: expect.objectContaining({ schemaVersion: "goat.debug.v1" }),
    });

    expect(sink.createAssistantMessage).toHaveBeenCalledWith({
      content: "",
      modelMessage: { role: "assistant", content: "" },
    });
    expect(sink.updateMessageContent).toHaveBeenCalledWith({
      messageId: "assistant_msg_1",
      content: "Done.",
    });
    expect(sink.completeMessage).toHaveBeenCalledWith({
      messageId: "assistant_msg_1",
      content: "Done.",
      modelMessage: { role: "assistant", content: "Done." },
    });
    expect(sink.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "harness.planned",
        payload: expect.objectContaining({
          model,
          tools: ["exa_search"],
          resultMode: "assistant_final",
        }),
      }),
    );
    expect(sink.recordModelUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "assistant_msg_1",
        phase: "execution",
        stepIndex: 0,
        modelProvider: "vercel-ai-gateway",
        modelName: model,
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      }),
    );
  });

  it("records planner usage and every execution finish-step", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: harnessSpec,
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    });
    aiMock.streamText.mockReturnValueOnce({
      fullStream: streamParts(
        { type: "text-delta", text: "Done" },
        { type: "finish-step", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
        { type: "finish-step", usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } },
      ),
      text: Promise.resolve("Done."),
    });
    const sink = createSink();

    await executeGoatTask({
      task: task(),
      env: env(),
      signal: new AbortController().signal,
      sink,
      reportStage: vi.fn(async () => {}),
    });

    expect(sink.recordModelUsage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        phase: "planner",
        stepIndex: 0,
        modelProvider: "vercel-ai-gateway",
        modelName: "anthropic/claude-sonnet-4.6",
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      }),
    );
    expect(sink.recordModelUsage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messageId: "assistant_msg_1",
        phase: "execution",
        stepIndex: 0,
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      }),
    );
    expect(sink.recordModelUsage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        messageId: "assistant_msg_1",
        phase: "execution",
        stepIndex: 1,
        usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
      }),
    );
  });

  it("fails the assistant message when final assistant content is empty", async () => {
    aiMock.generateObject.mockResolvedValueOnce({ object: harnessSpec });
    aiMock.streamText.mockReturnValueOnce({
      fullStream: streamParts({ type: "finish-step", usage: {} }),
      text: Promise.resolve(" "),
    });
    const sink = createSink();

    await expect(
      executeGoatTask({
        task: task(),
        env: env(),
        signal: new AbortController().signal,
        sink,
        reportStage: vi.fn(async () => {}),
      }),
    ).rejects.toThrow("Goat task completed without a final assistant message.");

    expect(sink.failMessage).toHaveBeenCalledWith({
      messageId: "assistant_msg_1",
      error: "Goat task completed without a final assistant message.",
    });
    expect(sink.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message.failed",
        messageId: "assistant_msg_1",
      }),
    );
  });
});

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
  };
}

async function* streamParts(...parts: Array<Record<string, unknown>>) {
  for (const part of parts) yield part;
}

function task(overrides: Partial<GoatTask> = {}): GoatTask {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Research Marseille",
    userWorkosId: "user_1",
    prompt: "Research Marseille.",
    model,
    status: "running",
    stage: "planning",
    result: null,
    error: null,
    harnessSpec,
    debugTrace: {},
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
    databaseUrl: "postgres://test",
    internalToken: "internal",
    streamTokenSecret: "stream",
    e2bApiKey: "e2b",
    vercelAiGatewayApiKey: "gateway",
    openaiCodexApiKey: undefined,
    publicUrl: undefined,
    llmBrokerEnabled: true,
    integrationCredentialEncryptionKey: Buffer.alloc(32, 0),
    exaApiKey: "exa",
    xApiBearerToken: undefined,
    supadataApiKey: undefined,
    ampApiKey: undefined,
    e2bTemplate: undefined,
    ampE2bTemplate: undefined,
    codexE2bTemplate: undefined,
    e2bSandboxIdleTimeoutMs: 30_000,
    opencodeTimeoutMs: 1_200_000,
    codexTimeoutMs: 1_200_000,
    codexModel: "gpt-5.5",
    toolArgRepairEnabled: false,
    jobLeaseTtlMs: 300_000,
    jobMaxLeaseBusyAttempts: 10,
    workerConcurrency: 2,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner_1",
    ...overrides,
  };
}
