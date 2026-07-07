import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { buildGoatHarnessRun } from "@/lib/task-harness-run";
import { TaskHarnessRunView } from "./TaskHarnessRunView";

describe("TaskHarnessRunView", () => {
  it("renders the durable user message, assistant message, tool rows, and result", () => {
    render(<TaskHarnessRunView run={runWithEvents()} />);

    expect(screen.getByText("Research Marseille")).toBeInTheDocument();
    expect(screen.getByText("Web search")).toBeInTheDocument();
    expect(screen.getAllByText("Done.").length).toBeGreaterThan(0);
    expect(screen.queryByText("Harness spec JSON")).not.toBeInTheDocument();
  });

  it("renders brain report results as artifact links", () => {
    render(<TaskHarnessRunView run={runWithArtifact()} />);

    expect(screen.getAllByText("Market report").length).toBeGreaterThan(0);
    expect(screen.getByText("research/market-report.md")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open/i })).toHaveAttribute(
      "href",
      "/brain/research/market-report",
    );
  });

  it("renders Codex reasoning as a collapsed Thinking row", async () => {
    const user = userEvent.setup();
    render(<TaskHarnessRunView run={runWithReasoning()} />);

    const toggle = screen.getByRole("button", { name: "Thinking" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Checked repository state.")).not.toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Checked repository state.")).toBeInTheDocument();
  });

  it("keeps tool input and output details collapsed until expanded", async () => {
    const user = userEvent.setup();
    render(<TaskHarnessRunView run={runWithEvents()} />);

    const toolDetails = screen.getByTestId("tool-call-call_search");
    const toggle = within(toolDetails).getByRole("button", { name: /Web search/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(toolDetails).queryByText("Input")).not.toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(toolDetails).getByText("Input")).toBeInTheDocument();
    expect(within(toolDetails).getByText("Output")).toBeInTheDocument();
  });

  it("renders Browser tool calls with useful details", async () => {
    const user = userEvent.setup();
    render(<TaskHarnessRunView run={runWithBrowserEvent()} />);

    const toolDetails = screen.getByTestId("tool-call-call_browser");
    const toggle = within(toolDetails).getByRole("button", { name: /Browser open/i });
    expect(toggle).toHaveTextContent("https://example.com/products");

    await user.click(toggle);

    expect(within(toolDetails).getByText("Input")).toBeInTheDocument();
    expect(within(toolDetails).getByText("Output")).toBeInTheDocument();
  });

  it("renders the legacy new-only detail message when no durable rows exist", () => {
    render(
      <TaskHarnessRunView
        run={buildGoatHarnessRun({
          task: task({ status: "succeeded", stage: "completed", result: "Stored result." }),
          messages: [],
          events: [],
        })}
      />,
    );

    expect(screen.getByText("Stored result.")).toBeInTheDocument();
    expect(
      screen.getByText("Detailed run events are available for new tasks only."),
    ).toBeInTheDocument();
  });
});

function runWithEvents() {
  return buildGoatHarnessRun({
    task: task({ status: "succeeded", stage: "completed", result: "Done." }),
    messages: [
      message({ id: "user_msg", role: "user", content: "Research Marseille" }),
      message({ id: "assistant_msg", role: "assistant", content: "Done." }),
    ],
    events: [
      event(1, "tool.started", {
        toolCallId: "call_search",
        toolName: "exa_search",
        input: { query: "Marseille history" },
      }),
      event(2, "tool.completed", {
        toolCallId: "call_search",
        toolName: "exa_search",
        input: { query: "Marseille history" },
        output: { results: [{ title: "Marseille" }] },
      }),
    ],
  });
}

function runWithBrowserEvent() {
  return buildGoatHarnessRun({
    task: task({ status: "succeeded", stage: "completed", result: "Done." }),
    messages: [
      message({ id: "user_msg", role: "user", content: "Find products" }),
      message({ id: "assistant_msg", role: "assistant", content: "Done." }),
    ],
    events: [
      event(1, "tool.completed", {
        toolCallId: "call_browser",
        toolName: "browser_open",
        input: { url: "https://example.com/products" },
        output: { ok: true, output: "Opened https://example.com/products" },
      }),
    ],
  });
}

function runWithArtifact() {
  return buildGoatHarnessRun({
    task: task({
      status: "succeeded",
      stage: "completed",
      result: "Research report saved to Brain: [Market report](/brain/research/market-report).",
    }),
    messages: [
      message({ id: "user_msg", role: "user", content: "Research the market" }),
      message({
        id: "assistant_msg",
        role: "assistant",
        content: "Research report saved to Brain: [Market report](/brain/research/market-report).",
      }),
    ],
    events: [
      event(1, "artifact.created", {
        artifact: {
          type: "brain_markdown_report",
          title: "Market report",
          documentId: "goat_brain_doc_1",
          brainId: "market-report",
          folderPath: "research",
          brainPath: "research/market-report.md",
          url: "/brain/research/market-report",
          mimeType: "text/markdown",
        },
      }),
    ],
  });
}

function runWithReasoning() {
  return buildGoatHarnessRun({
    task: task({ status: "succeeded", stage: "completed", result: "Done." }),
    messages: [
      message({ id: "user_msg", role: "user", content: "Fix tests" }),
      message({ id: "assistant_msg", role: "assistant", content: "Done." }),
    ],
    events: [
      event(
        1,
        "reasoning.completed",
        {
          text: "Checked repository state.",
        },
        "assistant_msg",
      ),
    ],
  });
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Research Marseille",
    prompt: "Research Marseille",
    model: "openai/gpt-5.4-mini",
    status: "running" as const,
    stage: "running" as const,
    result: null,
    error: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function message(overrides: { id: string; role: "user" | "assistant" | "tool"; content: string }) {
  return {
    id: overrides.id,
    taskId: "goat_task_1",
    userWorkosId: "user_1",
    role: overrides.role,
    status: "completed" as const,
    content: overrides.content,
    modelMessage: null,
    toolName: null,
    toolCallId: null,
    responseToMessageId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function event(
  id: number,
  type: "tool.started" | "tool.completed" | "artifact.created" | "reasoning.completed",
  payload: Record<string, unknown>,
  messageId: string | null = null,
) {
  return {
    id,
    taskId: "goat_task_1",
    userWorkosId: "user_1",
    messageId,
    type,
    payload,
    createdAt: new Date(`2026-01-01T00:00:${String(id).padStart(2, "0")}.000Z`),
  };
}
