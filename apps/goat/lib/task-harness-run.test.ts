import { describe, expect, it } from "vitest";
import { buildGoatHarnessRun, type GoatTaskRunEventInput } from "@/lib/task-harness-run";

describe("buildGoatHarnessRun", () => {
  it("builds a durable run transcript from messages and tool events", () => {
    const run = buildGoatHarnessRun({
      task: task({ status: "succeeded", stage: "completed", result: "Done." }),
      messages: [
        message({ id: "user_msg", role: "user", content: "Research Marseille" }),
        message({
          id: "assistant_msg",
          role: "assistant",
          status: "completed",
          content: "Done.",
        }),
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
          output: { results: [{ title: "Marseille", url: "https://example.com" }] },
        }),
      ],
    });

    expect(run.hasDurableRun).toBe(true);
    expect(run.userMessage?.content).toBe("Research Marseille");
    expect(run.assistantMessages[0]).toMatchObject({
      id: "assistant_msg",
      status: "completed",
      content: "Done.",
    });
    expect(run.toolCalls[0]).toMatchObject({
      id: "call_search",
      name: "exa_search",
      label: "Web search",
      kind: "search",
      status: "completed",
      inputPreview: expect.stringContaining("Marseille history"),
      outputPreview: expect.stringContaining("Marseille"),
    });
  });

  it("marks failed tool events and keeps the error preview separate", () => {
    const run = buildGoatHarnessRun({
      task: task({ status: "failed", stage: "failed", error: "Task failed." }),
      messages: [message({ id: "user_msg", role: "user", content: "Research" })],
      events: [
        event(1, "tool.started", {
          toolCallId: "call_search",
          toolName: "exa_search",
          input: { query: "market research" },
        }),
        event(2, "tool.failed", {
          toolCallId: "call_search",
          toolName: "exa_search",
          input: { query: "market research" },
          error: "Exa search failed (429): too many requests",
        }),
      ],
    });

    expect(run.toolCalls[0]).toMatchObject({
      status: "failed",
      outputPreview: "",
      errorPreview: "Exa search failed (429): too many requests",
    });
  });

  it("labels Gmail and Calendar tools", () => {
    const run = buildGoatHarnessRun({
      task: task(),
      messages: [],
      events: [
        event(1, "tool.completed", {
          toolCallId: "call_gmail",
          toolName: "gmail_search",
          input: { query: "newer_than:2d" },
          output: { messages: [{ subject: "Launch" }] },
        }),
        event(2, "tool.completed", {
          toolCallId: "call_calendar",
          toolName: "calendar_list_events",
          input: { calendarId: "primary" },
          output: { events: [{ summary: "Planning" }] },
        }),
      ],
    });

    expect(run.toolCalls.map((tool) => [tool.label, tool.kind])).toEqual([
      ["Gmail search", "gmail"],
      ["Calendar events", "calendar"],
    ]);
  });

  it("returns a legacy fallback model when no durable rows exist", () => {
    const run = buildGoatHarnessRun({
      task: task({ status: "succeeded", stage: "completed", result: "Stored result." }),
      messages: [],
      events: [],
    });

    expect(run.hasDurableRun).toBe(false);
    expect(run.task.result).toBe("Stored result.");
    expect(run.legacyDetailText).toBe("Detailed run events are available for new tasks only.");
  });

  it("bounds long previews without truncating raw JSON", () => {
    const longText = "x".repeat(2_000);
    const run = buildGoatHarnessRun({
      task: task(),
      messages: [],
      events: [
        event(1, "tool.completed", {
          toolCallId: "call_search",
          toolName: "exa_search",
          input: { query: longText },
          output: { text: longText },
        }),
      ],
    });

    const tool = run.toolCalls[0];
    expect(tool?.inputPreview.length).toBeLessThanOrEqual(900);
    expect(tool?.inputPreview).toMatch(/\.\.\.$/);
    expect(tool?.outputPreview.length).toBeLessThanOrEqual(900);
    expect(tool?.rawJson).toContain(longText);
  });
});

function task(overrides: Record<string, unknown> = {}) {
  return { ...taskBase(), ...overrides };
}

function taskBase() {
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
  };
}

function message(overrides: {
  id: string;
  role: "user" | "assistant" | "tool";
  status?: "created" | "running" | "completed" | "failed";
  content?: string;
}) {
  return {
    id: overrides.id,
    taskId: "goat_task_1",
    userWorkosId: "user_1",
    role: overrides.role,
    status: overrides.status ?? "completed",
    content: overrides.content ?? "",
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
  type: GoatTaskRunEventInput["type"],
  payload: Record<string, unknown>,
): GoatTaskRunEventInput {
  return {
    id,
    taskId: "goat_task_1",
    userWorkosId: "user_1",
    messageId: null,
    type,
    payload,
    createdAt: new Date(`2026-01-01T00:00:${String(id).padStart(2, "0")}.000Z`),
  };
}
