import { describe, expect, it, vi } from "vitest";
import { runOpenCompanyChatAgent } from "@/lib/chat-agent";
import {
  GOAT_BRAIN_TOOL_NAME,
  type GoatBrainToolInput,
  START_TASK_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  type WebSearchToolInput,
  type WebSearchToolOutput,
} from "@/lib/chat-ui";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { OPENCOMPANY_CHAT_SOUL, OPENCOMPANY_CHAT_SYSTEM } from "@/lib/prompts";

describe("runOpenCompanyChatAgent", () => {
  it("instructs the model to delegate latest-email checks", async () => {
    const startTask = vi.fn();

    await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "check my latest emails" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      generateTextImpl: (async (options: unknown) => {
        const system = extractSystemPrompt(options);
        expect(system).toContain(OPENCOMPANY_CHAT_SYSTEM);
        expect(system).toContain("You are OpenCompany");
        expect(system).toContain("Current date:");
        expect(system).toContain("Decide from the user's intent");
        expect(system).not.toContain("Use the web_search tool inside chat");
        expect(system).toContain("still call the task tool instead of refusing");
        expect(system).toContain("inbox");
        expect(system).toContain("Gmail");
        expect(system).toContain("goat_brain");
        expect(system).toContain(OPENCOMPANY_CHAT_SOUL);
        expect(system).toContain("founder-focused operator");
        expect(extractStartTaskToolDescription(options)).toContain(
          "specialized just-in-time agent",
        );
        return {
          text: "I'll start a task for that.",
          finishReason: "stop",
          steps: [],
        };
      }) as never,
    });

    expect(startTask).not.toHaveBeenCalled();
  });

  it("returns a normal assistant message without creating a task", async () => {
    const startTask = vi.fn();

    const result = await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "what do you think of x?" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      generateTextImpl: (async (options: unknown) => {
        expect(extractLastUserMessage(options)).toBe("what do you think of x?");
        return {
          text: "x has tradeoffs, but the direction seems reasonable.",
          finishReason: "stop",
          steps: [],
        };
      }) as never,
    });

    expect(startTask).not.toHaveBeenCalled();
    expect(result.task).toBeNull();
    expect(result.content).toBe("x has tradeoffs, but the direction seems reasonable.");
  });

  it("creates one queued task when the agent calls start_task", async () => {
    const startTask = vi.fn(async (task: { prompt: string; name?: string }) => ({
      id: "task_1",
      displayId: "TASK-1",
      name: task.name ?? "Market research for x",
      prompt: task.prompt,
    }));

    const result = await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "research the market for x" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      generateTextImpl: (async (options: unknown) => {
        const toolResult = await executeStartTaskTool(options, {
          name: "Market research for x",
          prompt: "Research the market for x and summarize the strongest signals.",
          reason: "Requires research and should be tracked.",
        });

        return {
          text: "I started a task and added it to Results.",
          finishReason: "stop",
          steps: [
            {
              toolCalls: [{ toolName: START_TASK_TOOL_NAME }],
              toolResults: [toolResult],
            },
          ],
        };
      }) as never,
    });

    expect(startTask).toHaveBeenCalledTimes(1);
    expect(startTask).toHaveBeenCalledWith({
      name: "Market research for x",
      prompt: "Research the market for x and summarize the strongest signals.",
      model: DEFAULT_GOAT_MODEL,
    });
    expect(result.task).toEqual({
      id: "task_1",
      displayId: "TASK-1",
      name: "Market research for x",
      prompt: "Research the market for x and summarize the strongest signals.",
    });
    expect(result.content).toBe("I started a task and added it to Results.");
  });

  it("can call the personal brain CLI inside the chat loop", async () => {
    const startTask = vi.fn();
    const runBrainCli = vi.fn(async (input: GoatBrainToolInput) => ({
      ok: true,
      exitCode: 0,
      stdout: "1. [inbox] Hiring note (hiring-note, score 1, updated 2026-01-01T00:00:00.000Z)",
      stderr: "",
      input,
    }));

    const result = await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "what did I say about hiring?" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      runBrainCli,
      generateTextImpl: (async (options: unknown) => {
        expect(extractGoatBrainToolDescription(options)).toContain("personal Goat Brain");
        expect(extractGoatBrainToolDescription(options)).toContain("ingest");
        const toolResult = await executeGoatBrainTool(options, {
          action: "query",
          text: "hiring",
          hops: 1,
          limit: 5,
        });

        return {
          text: "Your Brain has a hiring note in inbox.",
          finishReason: "stop",
          steps: [
            {
              toolCalls: [{ toolName: GOAT_BRAIN_TOOL_NAME }],
              toolResults: [toolResult],
            },
          ],
        };
      }) as never,
    });

    expect(startTask).not.toHaveBeenCalled();
    expect(runBrainCli).toHaveBeenCalledWith({
      action: "query",
      text: "hiring",
      hops: 1,
      limit: 5,
    });
    expect(result.task).toBeNull();
    expect(result.content).toBe("Your Brain has a hiring note in inbox.");
    expect(result.debugTrace.toolResults).toHaveLength(1);
  });

  it("can call web_search inside the chat loop without starting a task", async () => {
    const startTask = vi.fn();
    const webSearch = vi.fn(
      async (input: WebSearchToolInput): Promise<WebSearchToolOutput> => ({
        ok: true,
        query: input.query,
        searchedAt: "2026-07-04T12:00:00.000Z",
        results: [
          {
            title: "Google Blog",
            url: "https://blog.google",
            publishedDate: "2026-07-04",
            author: "Google",
            highlights: ["Google shared a current product update."],
          },
        ],
        requestId: "exa_req_123",
        costUsdMicros: 7000,
      }),
    );

    const result = await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "What are the latest updates on Google?" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      webSearch,
      currentDate: "2026-07-04T12:00:00.000Z",
      generateTextImpl: (async (options: unknown) => {
        const system = extractSystemPrompt(options);
        expect(system).toContain("Current date: 2026-07-04.");
        expect(system).toContain("Use the web_search tool inside chat");
        expect(system).toContain("Start a task when the user asks for deep research");
        expect(extractWebSearchToolDescription(options)).toContain("one-shot");

        const firstToolResult = await executeWebSearchTool(options, {
          query: "latest Google updates",
          recencyDays: 30,
        });
        const cappedToolResult = await executeWebSearchTool(options, {
          query: "another Google update",
        });
        expect(cappedToolResult).toMatchObject({
          ok: false,
          error: expect.stringContaining("limited to one search"),
        });

        return {
          text: "Google shared a current product update.\n\nSources:\n- [Google Blog](https://blog.google)",
          finishReason: "stop",
          steps: [
            {
              toolCalls: [{ toolName: WEB_SEARCH_TOOL_NAME }],
              toolResults: [firstToolResult],
            },
          ],
        };
      }) as never,
    });

    expect(startTask).not.toHaveBeenCalled();
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(webSearch).toHaveBeenCalledWith({
      query: "latest Google updates",
      recencyDays: 30,
    });
    expect(result.task).toBeNull();
    expect(result.content).toContain("Sources:");
    expect(result.content).toContain("[Google Blog](https://blog.google)");
  });
});

function extractSystemPrompt(options: unknown) {
  return (options as { system?: string }).system ?? "";
}

function extractStartTaskToolDescription(options: unknown) {
  type ToolOptions = { tools?: Record<typeof START_TASK_TOOL_NAME, { description?: string }> };
  return (options as ToolOptions).tools?.[START_TASK_TOOL_NAME]?.description ?? "";
}

function extractGoatBrainToolDescription(options: unknown) {
  type ToolOptions = { tools?: Record<typeof GOAT_BRAIN_TOOL_NAME, { description?: string }> };
  return (options as ToolOptions).tools?.[GOAT_BRAIN_TOOL_NAME]?.description ?? "";
}

function extractWebSearchToolDescription(options: unknown) {
  type ToolOptions = { tools?: Record<typeof WEB_SEARCH_TOOL_NAME, { description?: string }> };
  return (options as ToolOptions).tools?.[WEB_SEARCH_TOOL_NAME]?.description ?? "";
}

function extractLastUserMessage(options: unknown) {
  const messages = (options as { messages?: Array<{ role: string; content: string }> }).messages;
  return messages?.filter((message) => message.role === "user").at(-1)?.content;
}

async function executeStartTaskTool(
  options: unknown,
  input: { prompt: string; name: string; reason: string },
) {
  type ToolOptions = { tools?: Record<typeof START_TASK_TOOL_NAME, { execute?: unknown }> };
  const tool = (options as ToolOptions).tools?.[START_TASK_TOOL_NAME];
  if (typeof tool?.execute !== "function") {
    throw new Error(`${START_TASK_TOOL_NAME} execute function was not configured.`);
  }
  return tool.execute(input);
}

async function executeGoatBrainTool(options: unknown, input: Record<string, unknown>) {
  type ToolOptions = { tools?: Record<typeof GOAT_BRAIN_TOOL_NAME, { execute?: unknown }> };
  const tool = (options as ToolOptions).tools?.[GOAT_BRAIN_TOOL_NAME];
  if (typeof tool?.execute !== "function") {
    throw new Error(`${GOAT_BRAIN_TOOL_NAME} execute function was not configured.`);
  }
  return tool.execute(input);
}

async function executeWebSearchTool(options: unknown, input: WebSearchToolInput) {
  type ToolOptions = { tools?: Record<typeof WEB_SEARCH_TOOL_NAME, { execute?: unknown }> };
  const tool = (options as ToolOptions).tools?.[WEB_SEARCH_TOOL_NAME];
  if (typeof tool?.execute !== "function") {
    throw new Error(`${WEB_SEARCH_TOOL_NAME} execute function was not configured.`);
  }
  return tool.execute(input);
}
