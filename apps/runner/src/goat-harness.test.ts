import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { GoatHarnessSpec, goatTasks } from "@opencompany/db/goat-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import { executeGoatTask, type GoatTaskRunSink, planGoatHarness } from "./goat-harness";
import { GOAT_HARNESS_CREATION_SYSTEM_PROMPT } from "./prompts/goat-harness-creation";

const aiMock = vi.hoisted(() => ({
  generateObject: vi.fn(),
  streamText: vi.fn(),
  createGateway: vi.fn(() => (model: string) => ({ model })),
  jsonSchema: vi.fn((schema: unknown) => schema),
  stepCountIs: vi.fn((steps: number) => ({ steps })),
  tool: vi.fn((definition: unknown) => definition),
}));
const goatBrainMock = vi.hoisted(() => ({
  createGoatBrainMarkdownReportForTask: vi.fn(),
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

vi.mock("./goat-brain", () => goatBrainMock);

type GoatTask = typeof goatTasks.$inferSelect;

const model = "moonshotai/kimi-k2.6" as AgentModelId;
const claudeModel = "anthropic/claude-sonnet-5" as AgentModelId;
const gptModel = "openai/gpt-5.5" as AgentModelId;
const harnessSpec: GoatHarnessSpec = {
  schemaVersion: "goat.harness.v1",
  model,
  systemPrompt: "Use read-only tools and answer directly.",
  initialUserMessage: "Research Marseille.",
  tools: ["exa_search"],
  maxModelSteps: 8,
  resultMode: "assistant_final",
};
const reportHarnessSpec: GoatHarnessSpec = {
  ...harnessSpec,
  systemPrompt: "Write a sourced research report.",
  resultMode: "brain_markdown_report",
};

beforeEach(() => {
  vi.clearAllMocks();
  goatBrainMock.createGoatBrainMarkdownReportForTask.mockResolvedValue({
    type: "brain_markdown_report",
    title: "Marseille Market Research",
    documentId: "goat_brain_doc_1",
    brainId: "marseille-market-research",
    folderPath: "research",
    brainPath: "research/marseille-market-research.md",
    url: "/brain/research/marseille-market-research",
    mimeType: "text/markdown",
  });
});

describe("planGoatHarness", () => {
  it("produces goat.harness.v1 with operation-level tools and a planned execution model", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        model: claudeModel,
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
      model: claudeModel,
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
    expect(request.system).toContain("<goat_harness_planner>");
    expect(request.system).toContain("<tool_policy>");
    expect(request.system).toContain("<result_contract>");
    expect(request.system).toContain("there is no final-result tool");
    expect(request.system).toContain('resultMode "brain_markdown_report"');
    expect(request.system).toContain("<prompt_contract>");
    expect(request.system).toContain("Always return a non-empty systemPrompt");
    expect(request.prompt).toContain("<planner_inputs>");
    expect(request.prompt).toContain("<execution_model_options>");
    expect(request.prompt).toContain("<id>\nmoonshotai/kimi-k2.6\n</id>");
    expect(request.prompt).toContain("<selection_guidance>\nDefault.");
    expect(request.prompt).toContain("<id>\nanthropic/claude-sonnet-5\n</id>");
    expect(request.prompt).toContain("<id>\nopenai/gpt-5.5\n</id>");
    expect(request.prompt).toContain("<available_operation_tools>");
    expect(request.prompt).toContain("<tool>\nexa_search\n</tool>");
    expect(request.prompt).toContain("<tool>\ngmail_search\n</tool>");
    expect(request.prompt).toContain("<default_max_model_steps>\n8\n</default_max_model_steps>");
    expect(request.prompt).toContain("<task_prompt>");
    expect(request.prompt).toContain("no inbox access is available in chat");
  });

  it("defaults max steps and keeps at least exa_search when planner returns no valid tools", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        model,
        systemPrompt: "Run the research task with the selected tools.",
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
    expect(result.systemPrompt).toBe("Run the research task with the selected tools.");
  });

  it("rejects planner responses without a system prompt", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        model,
        systemPrompt: "",
        initialUserMessage: "Research Marseille.",
        tools: ["exa_search"],
        maxModelSteps: 8,
        resultMode: "assistant_final",
      },
    });

    await expect(
      planGoatHarness({
        prompt: "Research Marseille.",
        model,
        availableTools: ["exa_search"],
        gatewayApiKey: "gateway",
      }),
    ).rejects.toThrow("Goat harness planner must return a non-empty systemPrompt.");
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

  it("keeps GitHub repo tools when they are available", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        model: gptModel,
        systemPrompt: "Clone the requested repo, run tests, and open a PR only if requested.",
        initialUserMessage: "Change octo/private-repo and open a PR.",
        tools: [
          "github_clone_repository",
          "github_shell",
          "github_status",
          "github_open_pull_request",
        ],
        maxModelSteps: 8,
        resultMode: "assistant_final",
      },
    });

    await expect(
      planGoatHarness({
        prompt: "Change octo/private-repo and open a PR.",
        model,
        availableTools: [
          "exa_search",
          "github_clone_repository",
          "github_shell",
          "github_status",
          "github_open_pull_request",
        ],
        gatewayApiKey: "gateway",
      }),
    ).resolves.toMatchObject({
      model: gptModel,
      tools: [
        "github_clone_repository",
        "github_shell",
        "github_status",
        "github_open_pull_request",
      ],
    });

    const request = aiMock.generateObject.mock.calls[0]?.[0] as {
      system: string;
      prompt: string;
    };
    expect(request.system).toContain("github_clone_repository");
    expect(request.system).toContain("explicitly asked to publish");
    expect(request.prompt).toContain("github_open_pull_request");
  });

  it("keeps brain markdown report mode and augments the execution contract", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        model: claudeModel,
        systemPrompt: "Research the market deeply.",
        initialUserMessage: "Deep research the Marseille AI market.",
        tools: ["exa_search"],
        maxModelSteps: 10,
        resultMode: "brain_markdown_report",
      },
    });

    await expect(
      planGoatHarness({
        prompt: "Deep research the Marseille AI market.",
        model,
        availableTools: ["exa_search"],
        gatewayApiKey: "gateway",
      }),
    ).resolves.toEqual({
      schemaVersion: "goat.harness.v1",
      model: claudeModel,
      systemPrompt: expect.stringContaining("<brain_markdown_report_result_contract>"),
      initialUserMessage: "Deep research the Marseille AI market.",
      tools: ["exa_search"],
      maxModelSteps: 10,
      resultMode: "brain_markdown_report",
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

  it("saves brain markdown reports as artifacts and returns the brain link", async () => {
    aiMock.generateObject.mockResolvedValueOnce({ object: reportHarnessSpec });
    aiMock.streamText.mockReturnValueOnce({
      fullStream: streamParts(
        { type: "text-delta", text: "# Marseille Market Research\n\nFindings." },
        { type: "finish-step", usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } },
      ),
      text: Promise.resolve("# Marseille Market Research\n\nFindings."),
    });
    const sink = createSink();

    await expect(
      executeGoatTask({
        task: task({ name: "Marseille market research" }),
        env: env(),
        signal: new AbortController().signal,
        sink,
        reportStage: vi.fn(async () => {}),
      }),
    ).resolves.toEqual({
      result:
        "Research report saved to Brain: [Marseille Market Research](/brain/research/marseille-market-research).\n\nArtifact: `research/marseille-market-research.md`",
      harnessSpec: expect.objectContaining({ resultMode: "brain_markdown_report" }),
      debugTrace: expect.objectContaining({ schemaVersion: "goat.debug.v1" }),
      artifact: expect.objectContaining({
        type: "brain_markdown_report",
        brainPath: "research/marseille-market-research.md",
      }),
    });

    expect(goatBrainMock.createGoatBrainMarkdownReportForTask).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      taskId: "goat_task_1",
      title: "Marseille market research",
      markdown: "# Marseille Market Research\n\nFindings.",
    });
    expect(sink.updateMessageContent).not.toHaveBeenCalled();
    expect(sink.completeMessage).toHaveBeenCalledWith({
      messageId: "assistant_msg_1",
      content:
        "Research report saved to Brain: [Marseille Market Research](/brain/research/marseille-market-research).\n\nArtifact: `research/marseille-market-research.md`",
      modelMessage: {
        role: "assistant",
        content:
          "Research report saved to Brain: [Marseille Market Research](/brain/research/marseille-market-research).\n\nArtifact: `research/marseille-market-research.md`",
      },
    });
    expect(sink.appendEvent).toHaveBeenCalledWith({
      type: "artifact.created",
      messageId: "assistant_msg_1",
      payload: {
        artifact: expect.objectContaining({
          type: "brain_markdown_report",
          url: "/brain/research/marseille-market-research",
        }),
      },
    });
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
    scheduleId: null,
    scheduledFor: null,
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
    goatTaskWorkerEnabled: false,
    workerConcurrency: 2,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner_1",
    ...overrides,
  };
}
