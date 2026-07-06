import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import { buildGoatTaskTools } from "./goat-tools";

const toolMocks = vi.hoisted(() => ({
  executeHostedTool: vi.fn(),
  executeGoatGoogleTool: vi.fn(),
  executeGoatLinearMcpTool: vi.fn(),
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
});

describe("buildGoatTaskTools Exa query guard", () => {
  it("warns once on the fifth Exa search and continues through the tenth", async () => {
    toolMocks.executeHostedTool.mockResolvedValue({
      output: {
        results: [{ title: "Result", url: "https://example.com", text: "Summary" }],
      },
    });
    const tools = buildGoatTaskTools({
      selectedTools: ["exa_search"],
      userWorkosId: "user_1",
      env: env(),
      signal: new AbortController().signal,
      lifecycle: lifecycleMocks(),
    });
    const exa = toExecutableTool(tools.exa_search);

    const outputs: Record<string, unknown>[] = [];
    for (let index = 1; index <= 10; index += 1) {
      outputs.push(
        (await callTool(exa, {
          input: { query: `query ${index}` },
          toolCallId: `call_exa_${index}`,
        })) as Record<string, unknown>,
      );
    }

    expect(toolMocks.executeHostedTool).toHaveBeenCalledTimes(10);
    expect(outputs[4]).toMatchObject({
      ok: true,
      warning: "Exa tool calls can be expensive. Avoid more than 10 Exa searches for this task.",
    });
    expect(outputs.filter((output) => typeof output.warning === "string")).toHaveLength(1);
  });

  it("blocks Exa searches after the tenth without calling the hosted tool", async () => {
    toolMocks.executeHostedTool.mockResolvedValue({
      output: {
        results: [{ title: "Result", url: "https://example.com", text: "Summary" }],
      },
    });
    const tools = buildGoatTaskTools({
      selectedTools: ["exa_search"],
      userWorkosId: "user_1",
      env: env(),
      signal: new AbortController().signal,
      lifecycle: lifecycleMocks(),
    });
    const exa = toExecutableTool(tools.exa_search);

    let output: unknown;
    for (let index = 1; index <= 11; index += 1) {
      output = await callTool(exa, {
        input: { query: `query ${index}` },
        toolCallId: `call_exa_${index}`,
      });
    }

    expect(toolMocks.executeHostedTool).toHaveBeenCalledTimes(10);
    expect(output).toMatchObject({
      ok: false,
      blocked: true,
      error:
        "Exa search limit reached for this task. Report the result before doing more search work.",
    });
  });
});

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
