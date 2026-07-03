import { describe, expect, it, vi } from "vitest";
import { runOpenCompanyChatAgent } from "@/lib/chat-agent";
import { GOAT_BRAIN_TOOL_NAME, START_TASK_TOOL_NAME } from "@/lib/chat-ui";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import {
  OPENCOMPANY_CHAT_BEHAVIOR,
  OPENCOMPANY_CHAT_SOUL,
  OPENCOMPANY_CHAT_SYSTEM,
} from "@/lib/prompts";

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
        expect(system).toContain(OPENCOMPANY_CHAT_BEHAVIOR);
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
    const runBrainCli = vi.fn(async (input: { args: string }) => ({
      ok: true,
      exitCode: 0,
      stdout: "1. [inbox] Hiring note (hiring-note, score 1, updated 2026-01-01T00:00:00.000Z)",
      stderr: "",
      args: input.args,
    }));

    const result = await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "what did I say about hiring?" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      runBrainCli,
      generateTextImpl: (async (options: unknown) => {
        expect(extractGoatBrainToolDescription(options)).toContain("personal Goat brain CLI");
        expect(extractGoatBrainToolDescription(options)).toContain("references");
        expect(extractGoatBrainToolDescription(options)).toContain("docs");
        const toolResult = await executeGoatBrainTool(options, {
          args: 'query --text "hiring" --hops 1 --limit 5',
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
      args: 'query --text "hiring" --hops 1 --limit 5',
    });
    expect(result.task).toBeNull();
    expect(result.content).toBe("Your Brain has a hiring note in inbox.");
    expect(result.debugTrace.toolResults).toHaveLength(1);
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

async function executeGoatBrainTool(options: unknown, input: { args: string }) {
  type ToolOptions = { tools?: Record<typeof GOAT_BRAIN_TOOL_NAME, { execute?: unknown }> };
  const tool = (options as ToolOptions).tools?.[GOAT_BRAIN_TOOL_NAME];
  if (typeof tool?.execute !== "function") {
    throw new Error(`${GOAT_BRAIN_TOOL_NAME} execute function was not configured.`);
  }
  return tool.execute(input);
}
