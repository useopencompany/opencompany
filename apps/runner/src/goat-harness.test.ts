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
const goatCodexMock = vi.hoisted(() => ({
  runGoatCodexTask: vi.fn(),
}));
const goatAttachmentsMock = vi.hoisted(() => ({
  buildGoatTaskUserModelMessage: vi.fn(async (input: { prompt: string }) => ({
    role: "user" as const,
    content: input.prompt,
  })),
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
vi.mock("./goat-codex", () => goatCodexMock);
vi.mock("./goat-attachments", () => goatAttachmentsMock);

type GoatTask = typeof goatTasks.$inferSelect;

const model = "moonshotai/kimi-k2.6" as AgentModelId;
const claudeModel = "anthropic/claude-sonnet-5" as AgentModelId;
const gptModel = "openai/gpt-5.5" as AgentModelId;
const harnessSpec: GoatHarnessSpec = {
  schemaVersion: "goat.harness.v1",
  engine: "opencompany",
  model,
  systemPrompt: "Use read-only tools and answer directly.",
  initialUserMessage: "Research Marseille.",
  tools: ["exa_search"],
  skills: [],
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
  goatCodexMock.runGoatCodexTask.mockResolvedValue({
    content: "Codex completed.",
    sandboxId: "sbx_codex",
    sandboxStartedAt: new Date("2026-01-01T00:00:00.000Z"),
    sandboxEndedAt: new Date("2026-01-01T00:01:00.000Z"),
    model: "gpt-5.5",
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
  });
  goatAttachmentsMock.buildGoatTaskUserModelMessage.mockImplementation(
    async (input: { prompt: string }) => ({
      role: "user" as const,
      content: input.prompt,
    }),
  );
});

describe("planGoatHarness", () => {
  it("produces goat.harness.v1 with operation-level tools and a planned execution model", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        engine: "opencompany",
        model: claudeModel,
        systemPrompt: "Use Gmail.",
        initialUserMessage: "Use Gmail to summarize the latest emails.",
        tools: ["gmail_search", "shell", "goat_result"],
        skills: [],
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
      engine: "opencompany",
      model: claudeModel,
      systemPrompt: "Use Gmail.",
      initialUserMessage: "Use Gmail to summarize the latest emails.",
      tools: ["gmail_search"],
      skills: [],
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
    expect(request.system).toContain("<skill_policy>");
    expect(request.system).toContain("<codex_goal_policy>");
    expect(request.system).toContain("set codex.goalMode only");
    expect(request.system).toContain("<result_contract>");
    expect(request.system).toContain("there is no final-result tool");
    expect(request.system).toContain('resultMode "brain_markdown_report"');
    expect(request.system).toContain("Use exa_search for broad web discovery");
    expect(request.system).toContain(
      "Use browser_* tools when the task depends on rendered websites",
    );
    expect(request.system).toContain("Never instruct the execution model to log in");
    expect(request.system).toContain("never infer slugs from titles");
    expect(request.system).toContain("<prompt_contract>");
    expect(request.system).toContain("Always return a non-empty systemPrompt");
    expect(request.system).toContain('Use engine "codex" for coding tasks');
    expect(request.prompt).toContain("<planner_inputs>");
    expect(request.prompt).toContain("<execution_engine_options>");
    expect(request.prompt).toContain("<id>\nopencompany\n</id>");
    expect(request.prompt).toContain("<id>\ncodex\n</id>");
    expect(request.prompt).toContain("<execution_model_options>");
    expect(request.prompt).toContain("<id>\nmoonshotai/kimi-k2.6\n</id>");
    expect(request.prompt).toContain("<selection_guidance>\nDefault.");
    expect(request.prompt).toContain("<id>\nanthropic/claude-sonnet-5\n</id>");
    expect(request.prompt).toContain("<id>\nopenai/gpt-5.5\n</id>");
    expect(request.prompt).toContain("<available_operation_tools>");
    expect(request.prompt).toContain("<tool>\nexa_search\n</tool>");
    expect(request.prompt).toContain("<tool>\ngmail_search\n</tool>");
    expect(request.prompt).toContain("<available_skills>");
    expect(request.prompt).toContain("<id>\nfirst-principles\n</id>");
    expect(request.prompt).toContain("<id>\nyc-office-hours\n</id>");
    expect(request.prompt).toContain("<default_max_model_steps>\n16\n</default_max_model_steps>");
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
        skills: ["unknown-skill"],
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
      skills: [],
      maxModelSteps: 16,
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
        skills: [],
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
        skills: [],
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
        engine: "opencompany",
        model: gptModel,
        systemPrompt: "Clone the requested repo, run tests, and open a PR only if requested.",
        initialUserMessage: "Change octo/private-repo and open a PR.",
        tools: [
          "github_clone_repository",
          "github_shell",
          "github_status",
          "github_open_pull_request",
        ],
        skills: [],
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

  it("keeps Browser tools when rendered-site navigation is available", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        model: claudeModel,
        systemPrompt:
          "Use Browser for rendered product-page inspection. Do not log in, purchase, or check out.",
        initialUserMessage: "Find three wireless mice on Amazon under $50.",
        tools: ["exa_search", "browser_open", "browser_snapshot", "browser_click", "browser_read"],
        skills: [],
        maxModelSteps: 14,
        resultMode: "assistant_final",
      },
    });

    await expect(
      planGoatHarness({
        prompt: "Find three wireless mice on Amazon under $50.",
        model,
        availableTools: [
          "exa_search",
          "browser_open",
          "browser_snapshot",
          "browser_click",
          "browser_read",
        ],
        gatewayApiKey: "gateway",
      }),
    ).resolves.toMatchObject({
      model: claudeModel,
      tools: ["exa_search", "browser_open", "browser_snapshot", "browser_click", "browser_read"],
      maxModelSteps: 16,
    });

    const request = aiMock.generateObject.mock.calls[0]?.[0] as { prompt: string };
    expect(request.prompt).toContain("<tool>\nbrowser_open\n</tool>");
    expect(request.prompt).toContain("<tool>\nbrowser_read\n</tool>");
  });

  it("keeps brain markdown report mode and augments the execution contract", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        engine: "opencompany",
        model: claudeModel,
        systemPrompt: "Research the market deeply.",
        initialUserMessage: "Deep research the Marseille AI market.",
        tools: ["exa_search"],
        skills: [],
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
      engine: "opencompany",
      model: claudeModel,
      systemPrompt: expect.stringContaining("<brain_markdown_report_result_contract>"),
      initialUserMessage: "Deep research the Marseille AI market.",
      tools: ["exa_search"],
      skills: [],
      maxModelSteps: 10,
      resultMode: "brain_markdown_report",
    });
  });

  it("keeps Codex as the selected engine for explicit Codex coding tasks", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        engine: "codex",
        model: gptModel,
        systemPrompt: "Use Codex to edit the repository and summarize the diff.",
        initialUserMessage: "Use Codex to fix the failing tests in octo/repo.",
        tools: ["exa_search"],
        skills: [],
        maxModelSteps: 8,
        resultMode: "assistant_final",
        codex: {
          repository: "octo/repo",
          createPullRequest: false,
          reasoningEffort: "high",
        },
      },
    });

    await expect(
      planGoatHarness({
        prompt: "Use Codex to fix the failing tests in octo/repo.",
        model,
        availableTools: ["exa_search", "github_clone_repository", "github_shell"],
        gatewayApiKey: "gateway",
      }),
    ).resolves.toMatchObject({
      engine: "codex",
      model: gptModel,
      codex: {
        repository: "octo/repo",
        createPullRequest: false,
        reasoningEffort: "high",
      },
    });
  });

  it("enforces a requested Codex engine even if the planner response downgrades it", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        engine: "opencompany",
        model: claudeModel,
        systemPrompt: "Inspect the repository and report readiness.",
        initialUserMessage:
          "Check out opencompany-experimental and report whether development work can start.",
        tools: ["github_clone_repository", "github_shell"],
        skills: [],
        maxModelSteps: 8,
        resultMode: "assistant_final",
      },
    });

    await expect(
      planGoatHarness({
        prompt: "Check out opencompany-experimental and report whether development work can start.",
        model,
        requestedEngine: "codex",
        availableTools: ["github_clone_repository", "github_shell"],
        gatewayApiKey: "gateway",
      }),
    ).resolves.toMatchObject({
      engine: "codex",
      model: gptModel,
      codex: {
        createPullRequest: false,
      },
    });
    const prompt = aiMock.generateObject.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain("<requested_engine>\ncodex\n</requested_engine>");
  });

  it("normalizes planner-selected Codex goal mode with a default token budget", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        engine: "codex",
        model: gptModel,
        systemPrompt: "Use Codex to edit the repository, run tests, and continue until verified.",
        initialUserMessage: "Fix the flaky test suite in octo/repo and verify the fix.",
        tools: ["exa_search"],
        skills: [],
        maxModelSteps: 8,
        resultMode: "assistant_final",
        codex: {
          repository: "octo/repo",
          createPullRequest: false,
          reasoningEffort: "high",
          goalMode: {
            objective: "Fix the flaky tests in octo/repo and verify the suite passes.",
          },
        },
      },
    });

    await expect(
      planGoatHarness({
        prompt: "Use Codex to fix the flaky test suite in octo/repo and verify it.",
        model,
        availableTools: ["exa_search", "github_clone_repository", "github_shell"],
        githubRepositories: ["octo/repo"],
        gatewayApiKey: "gateway",
      }),
    ).resolves.toMatchObject({
      engine: "codex",
      codex: {
        repository: "octo/repo",
        goalMode: {
          objective: "Fix the flaky tests in octo/repo and verify the suite passes.",
          tokenBudget: 200_000,
        },
      },
    });
  });

  it("infers a Codex repository and PR intent from connected repository names", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        engine: "codex",
        model: gptModel,
        systemPrompt: "Use Codex to edit the repository and summarize the result.",
        initialUserMessage: "Fix Yellowknife and open a PR.",
        tools: ["exa_search"],
        skills: [],
        maxModelSteps: 8,
        resultMode: "assistant_final",
        codex: {
          repository: null,
          createPullRequest: false,
          reasoningEffort: "medium",
        },
      },
    });

    await expect(
      planGoatHarness({
        prompt: "Use Codex to fix Yellowknife and open a PR.",
        model,
        availableTools: ["exa_search", "github_clone_repository", "github_shell"],
        githubRepositories: ["OpenCompany/Yellowknife"],
        gatewayApiKey: "gateway",
      }),
    ).resolves.toMatchObject({
      engine: "codex",
      codex: {
        repository: "OpenCompany/Yellowknife",
        createPullRequest: true,
        reasoningEffort: "medium",
      },
    });

    const request = aiMock.generateObject.mock.calls[0]?.[0] as {
      system: string;
      prompt: string;
    };
    expect(request.system).toContain("available_github_repositories");
    expect(request.system).toContain("codex.createPullRequest true");
    expect(request.prompt).toContain("<available_github_repositories>");
    expect(request.prompt).toContain("<repository>\nOpenCompany/Yellowknife\n</repository>");
  });

  it("lets an explicit no-PR prompt override an over-eager planner", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        engine: "codex",
        model: gptModel,
        systemPrompt: "Use Codex to edit the repository and summarize the result.",
        initialUserMessage: "Fix octo/repo but do not open a PR.",
        tools: ["exa_search"],
        skills: [],
        maxModelSteps: 8,
        resultMode: "assistant_final",
        codex: {
          repository: "https://github.com/octo/repo.git",
          createPullRequest: true,
          reasoningEffort: "high",
        },
      },
    });

    await expect(
      planGoatHarness({
        prompt: "Use Codex to fix octo/repo but do not open a PR.",
        model,
        availableTools: ["exa_search", "github_clone_repository", "github_shell"],
        githubRepositories: ["octo/repo"],
        gatewayApiKey: "gateway",
      }),
    ).resolves.toMatchObject({
      engine: "codex",
      codex: {
        repository: "octo/repo",
        createPullRequest: false,
      },
    });
  });

  it("keeps selected skills and injects their execution guidance into the system prompt", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        schemaVersion: "goat.harness.v1",
        model: claudeModel,
        systemPrompt: "Help the founder decide what to build next.",
        initialUserMessage: "Run YC-style office hours and reason from first principles.",
        tools: ["exa_search"],
        skills: ["yc-office-hours", "first-principles", "unknown-skill", "yc-office-hours"],
        maxModelSteps: 8,
        resultMode: "assistant_final",
      },
    });

    const result = await planGoatHarness({
      prompt: "Run YC-style office hours and reason from first principles.",
      model,
      availableTools: ["exa_search"],
      gatewayApiKey: "gateway",
    });

    expect(result.skills).toEqual(["yc-office-hours", "first-principles"]);
    expect(result.systemPrompt).toContain("<skill:yc-office-hours>");
    expect(result.systemPrompt).toContain("YC-style office-hours loop");
    expect(result.systemPrompt).toContain("<skill:first-principles>");
    expect(result.systemPrompt).toContain("bedrock facts");
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
          skills: [],
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

  it("reserves the last Goat model step for a no-tool final answer", async () => {
    aiMock.generateObject.mockResolvedValueOnce({ object: harnessSpec });
    aiMock.streamText.mockReturnValueOnce({
      fullStream: streamParts(
        { type: "text-delta", text: "Done." },
        { type: "finish-step", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
      ),
      text: Promise.resolve("Done."),
    });

    await executeGoatTask({
      task: task(),
      env: env(),
      signal: new AbortController().signal,
      sink: createSink(),
      reportStage: vi.fn(async () => {}),
    });

    const request = aiMock.streamText.mock.calls[0]?.[0] as {
      prepareStep?: (input: { stepNumber: number }) => unknown;
    };

    expect(request.prepareStep?.({ stepNumber: harnessSpec.maxModelSteps - 2 })).toEqual({});
    const finalSettings = request.prepareStep?.({ stepNumber: harnessSpec.maxModelSteps - 1 });
    expect(finalSettings).toMatchObject({
      activeTools: [],
      toolChoice: "none",
      system: expect.stringContaining("Do not call any more tools"),
    });
    const system =
      finalSettings && typeof finalSettings === "object" && "system" in finalSettings
        ? String(finalSettings.system)
        : "";
    expect(system).toContain(harnessSpec.systemPrompt);
    expect(system).toContain("provide the best final answer now");
  });

  it("runs Codex harnesses through the Codex sandbox executor", async () => {
    const codexHarnessSpec: GoatHarnessSpec = {
      ...harnessSpec,
      engine: "codex",
      model: gptModel,
      systemPrompt: "Use Codex.",
      initialUserMessage: "Fix octo/repo.",
      codex: {
        repository: "octo/repo",
        createPullRequest: true,
        reasoningEffort: "high",
        goalMode: {
          objective: "Fix octo/repo and verify tests pass.",
          tokenBudget: 200_000,
        },
      },
    };
    aiMock.generateObject.mockResolvedValueOnce({ object: codexHarnessSpec });
    goatCodexMock.runGoatCodexTask.mockImplementationOnce(async (input) => {
      await input.onOutput?.("I'll clone the repository.");
      await input.onRuntimeEvents?.([
        {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread_existing",
            turnId: "turn_1",
            itemId: "agent_1",
            delta: "I'll clone the repository.",
          },
        },
        {
          method: "item/completed",
          params: {
            threadId: "thread_existing",
            turnId: "turn_1",
            item: {
              id: "agent_1",
              type: "agentMessage",
              text: "I'll clone the repository.",
            },
          },
        },
        {
          method: "item/completed",
          params: {
            threadId: "thread_existing",
            turnId: "turn_1",
            item: {
              id: "reasoning_1",
              type: "reasoning",
              text: "Checked the repository state.",
            },
          },
        },
        {
          method: "item/completed",
          params: {
            threadId: "thread_existing",
            turnId: "turn_1",
            item: {
              id: "cmd_1",
              type: "commandExecution",
              command: "git log --oneline -10",
              status: "completed",
              exitCode: 0,
            },
          },
        },
      ]);
      return {
        content: "Codex completed.",
        sandboxId: "sbx_codex",
        sandboxStartedAt: new Date("2026-01-01T00:00:00.000Z"),
        sandboxEndedAt: new Date("2026-01-01T00:01:00.000Z"),
        model: "gpt-5.5",
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      };
    });
    const sink = createSink();

    await expect(
      executeGoatTask({
        task: task({ codexEngineSessionId: "thread_existing" }),
        env: env(),
        signal: new AbortController().signal,
        sink,
        reportStage: vi.fn(async () => {}),
      }),
    ).resolves.toMatchObject({
      result: "Codex completed.",
      harnessSpec: codexHarnessSpec,
    });

    expect(goatCodexMock.runGoatCodexTask).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        prompt: "Fix octo/repo.",
        existingEngineSessionId: "thread_existing",
        repository: "octo/repo",
        createPullRequest: true,
        goalMode: {
          objective: "Fix octo/repo and verify tests pass.",
          tokenBudget: 200_000,
        },
        onEngineSessionId: sink.updateCodexEngineSessionId,
        onRuntimeEvents: expect.any(Function),
      }),
    );
    expect(sink.updateMessageContent).toHaveBeenCalledWith({
      messageId: "assistant_msg_1",
      content: "I'll clone the repository.",
    });
    expect(sink.appendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "assistant.delta" }),
    );
    expect(sink.appendEvent).toHaveBeenCalledWith({
      type: "message.completed",
      messageId: "assistant_msg_1",
      payload: expect.objectContaining({
        source: "codex_app_server",
        role: "assistant",
        content: "I'll clone the repository.",
        itemId: "agent_1",
      }),
    });
    expect(sink.appendEvent).toHaveBeenCalledWith({
      type: "reasoning.completed",
      messageId: "assistant_msg_1",
      payload: expect.objectContaining({
        source: "codex_app_server",
        text: "Checked the repository state.",
        itemId: "reasoning_1",
      }),
    });
    expect(sink.appendEvent).toHaveBeenCalledWith({
      type: "tool.completed",
      messageId: "assistant_msg_1",
      payload: expect.objectContaining({
        source: "codex_app_server",
        toolCallId: "cmd_1",
        toolName: "codex_command",
        output: { status: "completed", exitCode: 0 },
      }),
    });
    expect(sink.recordSandboxUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx_codex",
        activeMs: 60_000,
        rawMetrics: expect.objectContaining({
          goalMode: true,
          goalStatus: null,
        }),
      }),
    );
    expect(sink.recordModelUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: "openai",
        modelName: "gpt-5.5",
        costOverride: expect.objectContaining({
          costBasis: { source: "codex_subscription" },
        }),
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

  it("preserves the root execution error when failing the assistant message also fails", async () => {
    aiMock.generateObject.mockResolvedValueOnce({ object: harnessSpec });
    aiMock.streamText.mockReturnValueOnce({
      fullStream: streamParts({ type: "finish-step", usage: {} }),
      text: Promise.resolve(" "),
    });
    const sink = createSink();
    vi.mocked(sink.failMessage).mockRejectedValueOnce(new Error("cleanup write failed"));

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
    updateCodexEngineSessionId: vi.fn(async () => {}),
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
    goatBrowserEnabled: false,
    agentBrowserProvider: undefined,
    browserlessApiKey: undefined,
    browserlessApiUrl: undefined,
    browserlessTtl: undefined,
    browserlessStealth: undefined,
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
