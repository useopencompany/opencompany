import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { buildGoatHarnessRun, type GoatTaskHarnessRunInput } from "@/lib/task-harness-run";
import { TaskHarnessRunView } from "./TaskHarnessRunView";

describe("TaskHarnessRunView", () => {
  it("renders the user message, assistant message, and tool rows", () => {
    render(<TaskHarnessRunView run={buildGoatHarnessRun(taskWithTrace())} />);

    expect(screen.getByText("Research Marseille")).toBeInTheDocument();
    expect(screen.getByText("I'll search the web and then return the result.")).toBeInTheDocument();
    expect(screen.getByText("Web search")).toBeInTheDocument();
    expect(screen.getByText("Done.")).toBeInTheDocument();
    expect(screen.queryByText("Final result")).not.toBeInTheDocument();
    expect(screen.queryByText("completed")).not.toBeInTheDocument();
    expect(screen.queryByText("Planning")).not.toBeInTheDocument();
    expect(screen.queryByText("Harness spec JSON")).not.toBeInTheDocument();
  });

  it("keeps tool input and output details collapsed until expanded", async () => {
    const user = userEvent.setup();
    render(<TaskHarnessRunView run={buildGoatHarnessRun(taskWithTrace())} />);

    const toolDetails = screen.getByTestId("tool-call-call_search");
    const toggle = within(toolDetails).getByRole("button", { name: /Web search/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(toolDetails).queryByText("Input")).not.toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(toolDetails).getByText("Input")).toBeInTheDocument();
    expect(within(toolDetails).getByText("Output")).toBeInTheDocument();
  });

  it("renders an empty state while no detailed trace exists", () => {
    render(<TaskHarnessRunView run={buildGoatHarnessRun(task())} />);

    expect(
      screen.getByText(/has not captured an assistant message or tool call yet/i),
    ).toBeInTheDocument();
  });
});

function task(overrides: Partial<GoatTaskHarnessRunInput> = {}): GoatTaskHarnessRunInput {
  return {
    prompt: "Research Marseille",
    model: "openai/gpt-5.4-mini",
    status: "queued",
    stage: "queued",
    result: null,
    error: null,
    harnessSpec: {},
    debugTrace: {},
    ...overrides,
  };
}

function taskWithTrace() {
  return task({
    status: "succeeded",
    stage: "completed",
    result: "Done.",
    harnessSpec: { prompt: "Research Marseille", tools: ["exa", "goat_result"] },
    debugTrace: {
      schemaVersion: "goat.debug.v1",
      planner: {
        model: "anthropic/claude-sonnet-4.6",
        request: { messages: [{ role: "user", content: "Plan the task" }] },
        response: { content: '{"tools":["exa","goat_result"]}' },
      },
      harness: {
        model: "openai/gpt-5.4-mini",
        systemPrompt: "Use tools and return goat_result.",
        toolChoice: "auto",
        turns: [
          {
            step: 0,
            requestMessages: [{ role: "user", content: "Research Marseille" }],
            responseMessage: {
              role: "assistant",
              content: "I'll search the web and then return the result.",
              tool_calls: [
                toolCall("call_search", "exa_search", { query: "Marseille history" }),
                toolCall("call_result", "goat_result", { text: "Done." }),
              ],
            },
            toolResults: [
              {
                toolCallId: "call_search",
                name: "exa_search",
                args: { query: "Marseille history" },
                result: { results: [{ title: "Marseille" }] },
              },
              {
                toolCallId: "call_result",
                name: "goat_result",
                args: { text: "Done." },
                result: { text: "Done." },
              },
            ],
          },
        ],
      },
    },
  });
}

function toolCall(id: string, name: string, args: unknown) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}
