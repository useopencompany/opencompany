import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import { buildGoatTaskToolRuntime, buildGoatTaskTools } from "./goat-tools";

const toolMocks = vi.hoisted(() => ({
  executeHostedTool: vi.fn(),
  executeGoatGoogleTool: vi.fn(),
  executeGoatLatitudeMcpTool: vi.fn(),
  executeGoatLinearMcpTool: vi.fn(),
  browserExecute: vi.fn(),
  browserCleanup: vi.fn(),
}));

vi.mock("./hosted-tools", () => ({
  executeHostedTool: toolMocks.executeHostedTool,
}));

vi.mock("./goat-google-tools", () => ({
  executeGoatGoogleTool: toolMocks.executeGoatGoogleTool,
  isGoatGoogleToolName: (name: string) => name.startsWith("gmail_") || name.startsWith("calendar_"),
}));

vi.mock("./goat-linear-mcp-tools", () => ({
  executeGoatLinearMcpTool: toolMocks.executeGoatLinearMcpTool,
  isGoatLinearMcpToolName: (name: string) =>
    name === "linear_search_tools" || name === "linear_use_tool",
}));

vi.mock("./goat-latitude-mcp-tools", () => ({
  executeGoatLatitudeMcpTool: toolMocks.executeGoatLatitudeMcpTool,
  isGoatLatitudeMcpToolName: (name: string) =>
    name === "latitude_search_tools" || name === "latitude_use_tool",
}));

vi.mock("./goat-browser-tools", () => ({
  createGoatBrowserToolSession: vi.fn(() => ({
    execute: toolMocks.browserExecute,
    cleanup: toolMocks.browserCleanup,
  })),
  isGoatBrowserToolName: (name: string) => name.startsWith("browser_"),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildGoatTaskTools usage metadata", () => {
  it("passes Exa provider usage through lifecycle completion", async () => {
    toolMocks.executeHostedTool.mockResolvedValueOnce({
      output: {
        results: [
          {
            title: "Marseille",
            url: "https://example.com/marseille",
            text: "Port city",
          },
        ],
      },
      usage: {
        provider: "exa",
        operation: "search",
        providerRequestId: "exa_req_1",
        costUsdMicros: 7_000,
        rawUsage: { requestId: "exa_req_1" },
      },
    });
    const lifecycle = lifecycleMocks();
    const tools = buildGoatTaskTools({
      selectedTools: ["exa_search"],
      userWorkosId: "user_1",
      env: env(),
      signal: new AbortController().signal,
      lifecycle,
    });

    await callTool(toExecutableTool(tools.exa_search), {
      input: { query: "Marseille" },
      toolCallId: "call_exa",
    });

    expect(lifecycle.onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "call_exa",
        toolName: "exa_search",
        messageId: "tool_msg_1",
        output: expect.objectContaining({
          ok: true,
          query: "Marseille",
          results: [expect.objectContaining({ title: "Marseille" })],
        }),
        usage: expect.objectContaining({
          provider: "exa",
          operation: "search",
          costUsdMicros: 7_000,
        }),
      }),
    );
  });

  it("passes X hosted-tool usage through lifecycle completion and compacts large output", async () => {
    toolMocks.executeHostedTool.mockResolvedValueOnce({
      output: {
        posts: Array.from({ length: 25 }, (_, index) => ({
          id: String(index + 1),
          caption: `${"complaint ".repeat(200)}${index + 1}`,
        })),
      },
      usage: {
        provider: "x",
        operation: "search",
        costUsdMicros: 6_000,
        rawUsage: { provider: "apify", actorId: "apidojo/tweet-scraper", itemsReturned: 25 },
      },
    });
    const lifecycle = lifecycleMocks();
    const tools = buildGoatTaskTools({
      selectedTools: ["x_search_posts"],
      userWorkosId: "user_1",
      env: env({ apifyApiToken: "apify" }),
      signal: new AbortController().signal,
      lifecycle,
    });

    const output = await callTool(toExecutableTool(tools.x_search_posts), {
      input: { query: "complaints", maxResults: 25 },
      toolCallId: "call_x",
    });

    expect(toolMocks.executeHostedTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "x_search_posts",
        enabledTools: [
          "x_search_posts",
          "x_get_profile",
          "x_get_user_posts",
          "x_get_discussion",
          "social_get_job",
        ],
      }),
    );
    expect(output).toMatchObject({
      posts: expect.arrayContaining([expect.objectContaining({ id: "1" })]),
    });
    expect((output as { posts: unknown[] }).posts).toHaveLength(20);
    expect(lifecycle.onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "call_x",
        toolName: "x_search_posts",
        usage: expect.objectContaining({
          provider: "x",
          operation: "search",
          costUsdMicros: 6_000,
        }),
      }),
    );
  });

  it("records zero-cost display usage for Google tools", async () => {
    toolMocks.executeGoatGoogleTool.mockResolvedValueOnce({ ok: true, messages: [] });
    const lifecycle = lifecycleMocks();
    const tools = buildGoatTaskTools({
      selectedTools: ["gmail_search"],
      userWorkosId: "user_1",
      env: env(),
      signal: new AbortController().signal,
      lifecycle,
    });

    await callTool(toExecutableTool(tools.gmail_search), {
      input: { query: "newer_than:1d" },
      toolCallId: "call_gmail",
    });

    expect(lifecycle.onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "gmail_search",
        usage: expect.objectContaining({
          provider: "gmail",
          operation: "gmail_search",
          costUsdMicros: 0,
          costSource: "subscription",
        }),
      }),
    );
  });

  it("records zero-cost display usage for the selected Linear MCP operation", async () => {
    toolMocks.executeGoatLinearMcpTool.mockResolvedValueOnce({ ok: true, issue: { id: "LIN-1" } });
    const lifecycle = lifecycleMocks();
    const tools = buildGoatTaskTools({
      selectedTools: ["linear_use_tool"],
      userWorkosId: "user_1",
      env: env(),
      signal: new AbortController().signal,
      lifecycle,
    });

    await callTool(toExecutableTool(tools.linear_use_tool), {
      input: { tool: "create_issue", arguments: { title: "Bug" } },
      toolCallId: "call_linear",
    });

    expect(lifecycle.onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "linear_use_tool",
        usage: expect.objectContaining({
          provider: "linear",
          operation: "create_issue",
          costUsdMicros: 0,
          costSource: "subscription",
        }),
      }),
    );
  });

  it("records zero-cost display usage for the selected Latitude MCP operation", async () => {
    toolMocks.executeGoatLatitudeMcpTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
    });
    const lifecycle = lifecycleMocks();
    const tools = buildGoatTaskTools({
      selectedTools: ["latitude_use_tool"],
      userWorkosId: "user_1",
      env: env(),
      signal: new AbortController().signal,
      lifecycle,
    });

    await callTool(toExecutableTool(tools.latitude_use_tool), {
      input: { tool: "list_traces", arguments: { projectId: "project_1" } },
      toolCallId: "call_latitude",
    });

    expect(lifecycle.onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "latitude_use_tool",
        usage: expect.objectContaining({
          provider: "latitude",
          operation: "list_traces",
          costUsdMicros: 0,
          costSource: "subscription",
        }),
      }),
    );
  });

  it("records browser usage and cleans up the browser session", async () => {
    toolMocks.browserExecute.mockResolvedValueOnce({
      output: { ok: true, command: "browser_open", output: "compact browser output" },
      transcriptOutput: { ok: true, command: "browser_open", output: "full transcript output" },
      usage: {
        provider: "browser",
        operation: "open",
        costUsdMicros: 0,
        costSource: "subscription",
        rawUsage: { toolName: "browser_open" },
      },
    });
    const lifecycle = lifecycleMocks();
    const runtime = buildGoatTaskToolRuntime({
      selectedTools: ["browser_open"],
      taskId: "goat_task_1",
      userWorkosId: "user_1",
      env: env({ goatBrowserEnabled: true }),
      signal: new AbortController().signal,
      lifecycle,
    });

    const output = await callTool(toExecutableTool(runtime.tools.browser_open), {
      input: { url: "https://example.com/" },
      toolCallId: "call_browser",
    });
    await runtime.cleanup();

    expect(toolMocks.browserExecute).toHaveBeenCalledWith({
      name: "browser_open",
      args: { url: "https://example.com/" },
    });
    expect(lifecycle.onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser_open",
        output: { ok: true, command: "browser_open", output: "full transcript output" },
        modelOutput: { ok: true, command: "browser_open", output: "compact browser output" },
        usage: expect.objectContaining({
          provider: "browser",
          operation: "open",
          costUsdMicros: 0,
          costSource: "subscription",
        }),
      }),
    );
    expect(output).toEqual({ ok: true, command: "browser_open", output: "compact browser output" });
    expect(toolMocks.browserCleanup).toHaveBeenCalledTimes(1);
  });
});

describe("buildGoatTaskTools Exa query guard", () => {
  it("blocks the ninth Exa search until the model emits assistant progress", async () => {
    toolMocks.executeHostedTool.mockResolvedValue({
      output: {
        results: [{ title: "Result", url: "https://example.com", text: "Summary" }],
      },
    });
    let assistantProgressVersion = 0;
    const tools = buildGoatTaskTools({
      selectedTools: ["exa_search"],
      userWorkosId: "user_1",
      env: env(),
      signal: new AbortController().signal,
      getAssistantProgressVersion: () => assistantProgressVersion,
      lifecycle: lifecycleMocks(),
    });
    const exa = toExecutableTool(tools.exa_search);

    const outputs: Record<string, unknown>[] = [];
    for (let index = 1; index <= 8; index += 1) {
      outputs.push(
        (await callTool(exa, {
          input: { query: `query ${index}` },
          toolCallId: `call_exa_${index}`,
        })) as Record<string, unknown>,
      );
    }

    expect(toolMocks.executeHostedTool).toHaveBeenCalledTimes(8);
    expect(outputs[6]).toMatchObject({ ok: true });
    expect(outputs[7]).toMatchObject({
      ok: true,
    });
    expect(outputs[7]?.warning).toBeUndefined();

    assistantProgressVersion += 1;
    const blockedDespitePreemptiveText = await callTool(exa, {
      input: { query: "query after preemptive text" },
      toolCallId: "call_exa_after_preemptive_text",
    });
    expect(toolMocks.executeHostedTool).toHaveBeenCalledTimes(8);
    expect(blockedDespitePreemptiveText).toMatchObject({
      ok: false,
      blocked: true,
      reflectionRequired: true,
    });

    const blockedAgainBeforeUpdate = await callTool(exa, {
      input: { query: "query before update" },
      toolCallId: "call_exa_before_update",
    });
    expect(toolMocks.executeHostedTool).toHaveBeenCalledTimes(8);
    expect(blockedAgainBeforeUpdate).toMatchObject({
      ok: false,
      blocked: true,
      reflectionRequired: true,
      error:
        "Pause Exa search and reflect briefly before continuing. Produce a quick assistant update with what you have learned, what is still missing, and the next specific search you would run if needed.",
    });

    assistantProgressVersion += 1;
    const allowedAfterProgress = await callTool(exa, {
      input: { query: "query after update" },
      toolCallId: "call_exa_after_update",
    });

    expect(toolMocks.executeHostedTool).toHaveBeenCalledTimes(9);
    expect(allowedAfterProgress).toMatchObject({
      ok: true,
      query: "query after update",
    });
  });

  it("blocks Exa searches after the thirty-second without calling the hosted tool", async () => {
    toolMocks.executeHostedTool.mockResolvedValue({
      output: {
        results: [{ title: "Result", url: "https://example.com", text: "Summary" }],
      },
    });
    let assistantProgressVersion = 0;
    const tools = buildGoatTaskTools({
      selectedTools: ["exa_search"],
      userWorkosId: "user_1",
      env: env(),
      signal: new AbortController().signal,
      getAssistantProgressVersion: () => assistantProgressVersion,
      lifecycle: lifecycleMocks(),
    });
    const exa = toExecutableTool(tools.exa_search);

    let output: unknown;
    let successfulSearches = 0;
    let attempt = 0;
    while (successfulSearches < 32) {
      attempt += 1;
      output = await callTool(exa, {
        input: { query: `query ${attempt}` },
        toolCallId: `call_exa_${attempt}`,
      });
      if (isRecord(output) && output.reflectionRequired) {
        assistantProgressVersion += 1;
        continue;
      }
      successfulSearches += 1;
    }
    assistantProgressVersion += 1;
    output = await callTool(exa, {
      input: { query: "query over total limit" },
      toolCallId: "call_exa_over_total_limit",
    });

    expect(toolMocks.executeHostedTool).toHaveBeenCalledTimes(32);
    expect(output).toMatchObject({
      ok: false,
      blocked: true,
      error:
        "Exa search limit reached for this run. You have used 32 Exa searches; produce a response from the evidence already gathered.",
    });
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

type ExecutableTool = {
  onInputAvailable(input: { input: unknown; toolCallId: string }): Promise<void>;
  execute(input: unknown, options: { toolCallId: string }): Promise<unknown>;
};

function toExecutableTool(value: unknown): ExecutableTool {
  return value as ExecutableTool;
}

async function callTool(tool: ExecutableTool, input: { input: unknown; toolCallId: string }) {
  await tool.onInputAvailable(input);
  return tool.execute(input.input, { toolCallId: input.toolCallId });
}

function lifecycleMocks() {
  return {
    onToolStarted: vi.fn(async () => ({ messageId: "tool_msg_1" })),
    onToolCompleted: vi.fn(async () => {}),
    onToolFailed: vi.fn(async () => {}),
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
    apifyApiToken: undefined,
    supadataApiKey: undefined,
    ampApiKey: undefined,
    e2bTemplate: undefined,
    ampE2bTemplate: undefined,
    codexE2bTemplate: undefined,
    e2bSandboxIdleTimeoutMs: 30_000,
    opencodeTimeoutMs: 1_200_000,
    codexTimeoutMs: 1_200_000,
    codexModel: "gpt-5.5",
    goatCodexChatIdleTimeoutMs: 1_800_000,
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
