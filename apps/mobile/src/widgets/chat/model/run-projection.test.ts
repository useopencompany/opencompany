import type { RunStreamEventDto } from "@opencompany/protocol/events";
import { describe, expect, it } from "vitest";
import type { RunCheckpoint } from "./chat-store";
import { projectRunEvent } from "./run-projection";

const checkpoint = (): RunCheckpoint => ({
  runId: "run_1",
  conversationId: "conversation_1",
  assistantMessageId: "message_1",
  status: "running",
  content: "",
  parts: [],
  cursor: null,
  presentationCursor: null,
  isStopping: false,
});

const durableEvent = (
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
): RunStreamEventDto =>
  ({
    id: `event_${sequence}`,
    runId: "run_1",
    attemptId: "attempt_1",
    cursor: `v1:${sequence}`,
    schemaVersion: "2026-03-20",
    occurredAt: "2026-09-20T10:00:00.000Z",
    type,
    payload,
  }) as RunStreamEventDto;

const textDelta = (text: string, startOffset: number, cursor: string): RunStreamEventDto => ({
  runId: "run_1",
  attemptNumber: 1,
  schemaVersion: "2026-03-20",
  occurredAt: "2026-09-20T10:00:00.000Z",
  type: "message.presentation_delta",
  presentationCursor: cursor,
  payload: {
    messageId: "message_1",
    startOffset,
    endOffset: startOffset + text.length,
    delta: text,
  },
});

describe("projectRunEvent", () => {
  it("does not move a tool when later text arrives or the tool completes", () => {
    let projected = projectRunEvent(checkpoint(), textDelta("Before.", 0, "p1:1-0"));
    projected = projectRunEvent(
      projected,
      durableEvent(1, "tool.started", { toolCallId: "tool_1", name: "Search" }),
    );
    projected = projectRunEvent(projected, textDelta("After.", 7, "p1:1-1"));
    projected = projectRunEvent(
      projected,
      durableEvent(2, "tool.completed", { toolCallId: "tool_1", summary: "Done" }),
    );

    expect(projected.parts.map((part) => part.type)).toEqual(["text", "tool", "text"]);
    expect(projected.parts[1]).toMatchObject({
      id: "tool:tool_1",
      status: "completed",
      summary: "Done",
    });
  });
});
