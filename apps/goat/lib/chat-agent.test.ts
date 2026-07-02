import { describe, expect, it, vi } from "vitest";
import { runGoatChatAgent } from "@/lib/chat-agent";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";

describe("runGoatChatAgent", () => {
  it("returns a normal assistant message without creating a task", async () => {
    const startTask = vi.fn();

    const result = await runGoatChatAgent({
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

  it("creates one queued task when the agent calls start_goat_task", async () => {
    const startTask = vi.fn(async (task: { prompt: string; name?: string }) => ({
      id: "task_1",
      displayId: "TASK-1",
      name: task.name ?? "Market research for x",
      prompt: task.prompt,
    }));

    const result = await runGoatChatAgent({
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
              toolCalls: [{ toolName: "start_goat_task" }],
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
});

function extractLastUserMessage(options: unknown) {
  const messages = (options as { messages?: Array<{ role: string; content: string }> }).messages;
  return messages?.filter((message) => message.role === "user").at(-1)?.content;
}

async function executeStartTaskTool(
  options: unknown,
  input: { prompt: string; name: string; reason: string },
) {
  const tool = (options as { tools?: { start_goat_task?: { execute?: unknown } } }).tools
    ?.start_goat_task;
  if (typeof tool?.execute !== "function") {
    throw new Error("start_goat_task execute function was not configured.");
  }
  return tool.execute(input);
}
