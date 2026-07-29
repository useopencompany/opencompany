import { describe, expect, it } from "vitest";
import { goatHarnessRunToChatMessages } from "@/lib/task-chat-messages";
import { buildGoatHarnessRun } from "@/lib/task-harness-run";

describe("goatHarnessRunToChatMessages", () => {
  it("maps a durable run into a user message and an assistant turn with tool + text parts", () => {
    const run = buildGoatHarnessRun({
      task: task(),
      messages: [
        message({ id: "user_msg", role: "user", content: "Run the morning test" }),
        message({
          id: "assistant_msg",
          role: "assistant",
          content: "All set.",
          created_at: "2026-01-01T00:00:02.000Z",
        }),
      ],
      events: [
        event({
          id: 1,
          type: "tool.started",
          created_at: "2026-01-01T00:00:01.000Z",
          payload: {
            toolCallId: "call_1",
            toolName: "update_task_status",
            input: { status: "done" },
          },
        }),
        event({
          id: 2,
          type: "tool.completed",
          created_at: "2026-01-01T00:00:01.500Z",
          payload: { toolCallId: "call_1", toolName: "update_task_status", output: { ok: true } },
        }),
      ],
    });

    const messages = goatHarnessRunToChatMessages(run);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "Run the morning test" }]);

    const assistant = messages[1];
    expect(assistant?.role).toBe("assistant");
    // Tool call (t+1s) precedes the assistant text (t+2s).
    expect(assistant?.parts[0]).toMatchObject({
      type: "tool-update_task_status",
      toolCallId: "call_1",
      state: "output-available",
      output: { ok: true },
    });
    expect(assistant?.parts[1]).toEqual({ type: "text", text: "All set." });
  });

  it("falls back to the stored result when there is no durable transcript", () => {
    const run = buildGoatHarnessRun({
      task: task({ result: "Hello world as a test." }),
      messages: [],
      events: [],
    });

    const messages = goatHarnessRunToChatMessages(run);

    expect(messages[0]).toMatchObject({ role: "user" });
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      parts: [{ type: "text", text: "Hello world as a test." }],
    });
  });

  it("keeps the stored result when only the initial user row is durable", () => {
    const run = buildGoatHarnessRun({
      task: task({ result: "Legacy result." }),
      messages: [message({ id: "user_msg", role: "user", content: "Run the morning test" })],
      events: [],
    });

    expect(goatHarnessRunToChatMessages(run).at(-1)).toMatchObject({
      role: "assistant",
      parts: [{ type: "text", text: "Legacy result." }],
    });
  });

  it("preserves every user and assistant turn in a continued task", () => {
    const run = buildGoatHarnessRun({
      task: task(),
      messages: [
        message({ id: "user_1", role: "user", content: "Run the morning test" }),
        message({
          id: "assistant_1",
          role: "assistant",
          content: "Morning is clear.",
          created_at: "2026-01-01T00:00:01.000Z",
        }),
        message({
          id: "user_2",
          role: "user",
          content: "Check the afternoon too.",
          created_at: "2026-01-01T00:00:02.000Z",
        }),
        message({
          id: "assistant_2",
          role: "assistant",
          content: "Afternoon is clear too.",
          created_at: "2026-01-01T00:00:03.000Z",
        }),
      ],
      events: [],
    });

    expect(goatHarnessRunToChatMessages(run).map((entry) => entry.parts[0])).toEqual([
      { type: "text", text: "Run the morning test" },
      { type: "text", text: "Morning is clear." },
      { type: "text", text: "Check the afternoon too." },
      { type: "text", text: "Afternoon is clear too." },
    ]);
  });

  it("marks a failed tool call as an output error", () => {
    const run = buildGoatHarnessRun({
      task: task(),
      messages: [message({ id: "user_msg", role: "user", content: "go" })],
      events: [
        event({
          id: 1,
          type: "tool.failed",
          created_at: "2026-01-01T00:00:01.000Z",
          payload: { toolCallId: "call_1", toolName: "update_task_status", error: "boom" },
        }),
      ],
    });

    const assistant = goatHarnessRunToChatMessages(run).at(-1);
    expect(assistant?.parts[0]).toMatchObject({
      type: "tool-update_task_status",
      state: "output-error",
      errorText: "boom",
    });
  });
});

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Morning Test",
    prompt: "Run the morning test",
    model: "openai/gpt-5.4-mini",
    status: "succeeded" as const,
    stage: "completed" as const,
    result: "All set.",
    error: null,
    workflowId: "morning-test",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:03.000Z"),
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    task_id: "goat_task_1",
    user_workos_id: "user_1",
    role: "assistant" as const,
    status: "completed" as const,
    content: "",
    model_message: null,
    tool_name: null,
    tool_call_id: null,
    response_to_message_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    task_id: "goat_task_1",
    user_workos_id: "user_1",
    message_id: null,
    type: "tool.started" as const,
    payload: {},
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
