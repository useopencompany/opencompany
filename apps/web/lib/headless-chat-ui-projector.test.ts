import { parseRunStreamEvent } from "@opencompany/protocol";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { HeadlessChatUiProjector } from "./headless-chat-ui-projector";

const occurredAt = "2026-08-11T15:18:56.000Z";

describe("HeadlessChatUiProjector", () => {
  it("keeps post-tool text in a new ordered text segment", () => {
    const projector = new HeadlessChatUiProjector("message_assistant_1");
    const chunks = project(projector, [
      event(1, "message.content_updated", {
        messageId: "message_assistant_1",
        content: "Before",
        complete: false,
      }),
      event(2, "tool.started", { toolCallId: "tool_1", name: "list_skills" }),
      event(3, "tool.completed", { toolCallId: "tool_1" }),
      presentation("p1:1786461536000-0", " after", 6),
      event(4, "message.content_updated", {
        messageId: "message_assistant_1",
        content: "Before after",
        complete: true,
      }),
    ]);

    expect(chunks).toEqual([
      { type: "text-start", id: "text_message_assistant_1_1" },
      { type: "text-delta", id: "text_message_assistant_1_1", delta: "Before" },
      { type: "text-end", id: "text_message_assistant_1_1" },
      {
        type: "tool-input-available",
        toolCallId: "tool_1",
        toolName: "list_skills",
        input: {},
      },
      {
        type: "tool-output-available",
        toolCallId: "tool_1",
        output: { ok: true },
      },
      { type: "text-start", id: "text_message_assistant_1_2" },
      { type: "text-delta", id: "text_message_assistant_1_2", delta: " after" },
      { type: "text-end", id: "text_message_assistant_1_2" },
    ]);
  });

  it("creates a tool boundary for approvals whose historical tool start is unavailable", () => {
    const projector = new HeadlessChatUiProjector("message_assistant_1");
    const chunks = project(projector, [
      event(1, "message.content_updated", {
        messageId: "message_assistant_1",
        content: "Check",
        complete: false,
      }),
      event(2, "approval.requested", {
        approvalId: "approval_1",
        kind: "use_action",
        prompt: "Approve?",
        action: "crm.update",
      }),
      event(3, "message.content_updated", {
        messageId: "message_assistant_1",
        content: "Check complete",
        complete: true,
      }),
    ]);

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-available",
      "tool-approval-request",
      "text-start",
      "text-delta",
      "text-end",
    ]);
    expect(chunks[3]).toEqual({
      type: "tool-input-available",
      toolCallId: "approval_1",
      toolName: "use_action",
      input: { action: "crm.update" },
    });
  });

  it("continues with a fresh segment after reconnect and closes it before cancellation", () => {
    const projector = new HeadlessChatUiProjector("message_assistant_1", "Existing", 4, [
      { toolCallId: "tool_1", toolName: "use_action", input: {} },
    ]);
    const chunks = [
      ...projector.rehydrate(),
      ...project(projector, [
        event(5, "message.content_updated", {
          messageId: "message_assistant_1",
          content: "Existing",
          complete: false,
        }),
        presentation("p1:1786461536050-0", " tail", 8),
        presentation("p1:1786461536100-0", "Existing tail", 0),
        event(6, "approval.requested", {
          approvalId: "approval_1",
          toolCallId: "tool_1",
          kind: "use_action",
          prompt: "Approve?",
        }),
        event(7, "run.canceled", { by: "user" }),
      ]),
    ];

    expect(chunks).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "tool_1",
        toolName: "use_action",
        input: {},
      },
      { type: "text-start", id: "text_message_assistant_1_5" },
      { type: "text-delta", id: "text_message_assistant_1_5", delta: " tail" },
      {
        type: "tool-approval-request",
        approvalId: "approval_1",
        toolCallId: "tool_1",
      },
      { type: "text-end", id: "text_message_assistant_1_5" },
      { type: "abort", reason: "Canceled by the user." },
    ]);
    expect(projector.content).toBe("Existing tail");
    expect(projector.segment).toBe(5);
    expect(projector.toolCallCheckpoint).toEqual([
      { toolCallId: "tool_1", toolName: "use_action", input: {} },
    ]);
  });

  it.each([
    {
      eventType: "tool.completed",
      payload: { toolCallId: "tool_1" },
      expected: { state: "output-available", output: { ok: true } },
    },
    {
      eventType: "tool.failed",
      payload: {
        toolCallId: "tool_1",
        code: "tool_failed",
        message: "Tool failed.",
      },
      expected: { state: "output-error", errorText: "Tool failed." },
    },
    {
      eventType: "approval.requested",
      payload: {
        approvalId: "approval_1",
        toolCallId: "tool_1",
        kind: "use_action",
        prompt: "Approve?",
      },
      expected: { state: "approval-requested", approval: { id: "approval_1" } },
    },
  ])("rehydrates the invocation before a resumed $eventType event", async (scenario) => {
    const projector = new HeadlessChatUiProjector("message_assistant_1", "", 0, [
      { toolCallId: "tool_1", toolName: "use_action", input: {} },
    ]);
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "message_assistant_1" },
      ...projector.rehydrate(),
      ...projector.project(event(2, scenario.eventType, scenario.payload)),
      { type: "finish", finishReason: "stop" },
    ];

    const { message, errors } = await consumeUiMessage(chunks);

    expect(errors).toEqual([]);
    expect(
      message?.parts.find((part) => "toolCallId" in part && part.toolCallId === "tool_1"),
    ).toMatchObject({
      type: "tool-use_action",
      toolCallId: "tool_1",
      ...scenario.expected,
    });
  });

  it("rejects a tool result whose invocation is absent from the checkpoint and event stream", () => {
    const projector = new HeadlessChatUiProjector("message_assistant_1");

    expect(() => projector.project(event(2, "tool.completed", { toolCallId: "tool_1" }))).toThrow(
      "tool.completed was received before tool.started for tool call tool_1.",
    );
  });

  it("discards a malformed persisted segment counter", () => {
    const projector = new HeadlessChatUiProjector(
      "message_assistant_1",
      "",
      "tampered" as unknown as number,
    );

    expect(project(projector, [presentation("p1:1786461536150-0", "Safe", 0)]).slice(0, 1)).toEqual(
      [{ type: "text-start", id: "text_message_assistant_1_1" }],
    );
  });
});

function project(
  projector: HeadlessChatUiProjector,
  events: ReturnType<typeof parseRunStreamEvent>[],
) {
  const chunks: UIMessageChunk[] = [];
  for (const value of events) chunks.push(...projector.project(value));
  chunks.push(...projector.finish());
  return chunks;
}

function event(sequence: number, type: string, payload: Record<string, unknown>) {
  return parseRunStreamEvent({
    id: `event_${sequence}`,
    runId: "run_1",
    attemptId: "attempt_1",
    cursor: `v1:${sequence}`,
    schemaVersion: 1,
    occurredAt,
    type,
    payload,
  });
}

function presentation(presentationCursor: string, delta: string, startOffset: number) {
  return parseRunStreamEvent({
    runId: "run_1",
    attemptNumber: 1,
    presentationCursor,
    schemaVersion: 1,
    occurredAt,
    type: "message.presentation_delta",
    payload: {
      messageId: "message_assistant_1",
      startOffset,
      endOffset: startOffset + delta.length,
      delta,
    },
  });
}

async function consumeUiMessage(chunks: UIMessageChunk[]) {
  const errors: unknown[] = [];
  let message: UIMessage | undefined;
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  for await (const value of readUIMessageStream<UIMessage>({
    stream,
    terminateOnError: true,
    onError: (error) => errors.push(error),
  })) {
    message = value;
  }
  return { message, errors };
}
