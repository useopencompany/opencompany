import { parseRunStreamEvent } from "@opencompany/protocol";
import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { HeadlessChatUiProjector } from "./headless-chat-ui-projector";

const occurredAt = "2026-08-11T15:18:56.000Z";

describe("HeadlessChatUiProjector", () => {
  it("streams reasoning live, ahead of and separate from answer text (issue #1192)", () => {
    const projector = new HeadlessChatUiProjector("message_assistant_1");
    const chunks = project(projector, [
      presentation("reasoning_1", "reasoning", "p1:1786461536000-0", "Checking the", 0),
      presentation("reasoning_1", "reasoning", "p1:1786461536010-0", " calendar", 13),
      partUpdated(1, "reasoning_1", "reasoning", 0, "done", "Checking the calendar"),
      partUpdated(2, "text_1", "text", 1, "streaming", "It is"),
      presentation("text_1", "text", "p1:1786461536020-0", " Friday.", 5),
      partUpdated(3, "text_1", "text", 1, "done", "It is Friday."),
    ]);

    expect(chunks).toEqual([
      { type: "reasoning-start", id: "reasoning_1" },
      { type: "reasoning-delta", id: "reasoning_1", delta: "Checking the" },
      { type: "reasoning-delta", id: "reasoning_1", delta: " calendar" },
      { type: "reasoning-end", id: "reasoning_1" },
      { type: "text-start", id: "text_1" },
      { type: "text-delta", id: "text_1", delta: "It is" },
      { type: "text-delta", id: "text_1", delta: " Friday." },
      { type: "text-end", id: "text_1" },
    ]);
  });

  it("preserves reasoning -> text -> tool -> reasoning -> text ordering", () => {
    const projector = new HeadlessChatUiProjector("message_assistant_1");
    const chunks = project(projector, [
      partUpdated(1, "reasoning_1", "reasoning", 0, "done", "First, check."),
      partUpdated(2, "text_1", "text", 1, "done", "Let me look."),
      event(3, "tool.started", { toolCallId: "tool_1", name: "goat_brain" }),
      event(4, "tool.completed", { toolCallId: "tool_1" }),
      partUpdated(5, "reasoning_2", "reasoning", 3, "done", "It's Friday."),
      partUpdated(6, "text_2", "text", 4, "done", "It's Friday."),
    ]);

    expect(
      chunks.map((chunk) => ("id" in chunk ? `${chunk.type}:${chunk.id}` : chunk.type)),
    ).toEqual([
      "reasoning-start:reasoning_1",
      "reasoning-delta:reasoning_1",
      "reasoning-end:reasoning_1",
      "text-start:text_1",
      "text-delta:text_1",
      "text-end:text_1",
      "tool-input-available",
      "tool-output-available",
      "reasoning-start:reasoning_2",
      "reasoning-delta:reasoning_2",
      "reasoning-end:reasoning_2",
      "text-start:text_2",
      "text-delta:text_2",
      "text-end:text_2",
    ]);
  });

  it("does not double-render text from the compatible message.content_updated projection", () => {
    // message.content_updated stays on the wire (the compatible final-answer text projection)
    // but must not be applied here, since message.part_updated already streams the same text.
    const projector = new HeadlessChatUiProjector("message_assistant_1");
    const chunks = project(projector, [
      partUpdated(1, "text_1", "text", 0, "streaming", "Hello"),
      event(2, "message.content_updated", {
        messageId: "message_assistant_1",
        content: "Hello",
        complete: false,
      }),
      partUpdated(3, "text_1", "text", 0, "done", "Hello world"),
      event(4, "message.content_updated", {
        messageId: "message_assistant_1",
        content: "Hello world",
        complete: true,
      }),
    ]);

    expect(chunks).toEqual([
      { type: "text-start", id: "text_1" },
      { type: "text-delta", id: "text_1", delta: "Hello" },
      { type: "text-delta", id: "text_1", delta: " world" },
      { type: "text-end", id: "text_1" },
    ]);
  });

  it("closes an open reasoning or text part before a tool or approval boundary starts", () => {
    const projector = new HeadlessChatUiProjector("message_assistant_1");
    const chunks = project(projector, [
      partUpdated(1, "reasoning_1", "reasoning", 0, "streaming", "Thinking"),
      event(2, "approval.requested", {
        approvalId: "approval_1",
        kind: "use_action",
        prompt: "Approve?",
        action: "crm.update",
      }),
    ]);

    expect(chunks).toEqual([
      { type: "reasoning-start", id: "reasoning_1" },
      { type: "reasoning-delta", id: "reasoning_1", delta: "Thinking" },
      { type: "reasoning-end", id: "reasoning_1" },
      {
        type: "tool-input-available",
        toolCallId: "approval_1",
        toolName: "use_action",
        input: { action: "crm.update" },
      },
      { type: "tool-approval-request", approvalId: "approval_1", toolCallId: "approval_1" },
    ]);
  });

  it("resumes a still-open part after reconnect without re-emitting its start chunk", () => {
    const projector = new HeadlessChatUiProjector(
      "message_assistant_1",
      [{ id: "reasoning_1", kind: "reasoning", text: "Thinking about", done: false }],
      ["tool_1"],
    );
    const chunks = project(projector, [
      presentation("reasoning_1", "reasoning", "p1:1786461536200-0", " the launch", 14),
      partUpdated(5, "reasoning_1", "reasoning", 0, "done", "Thinking about the launch"),
      event(6, "run.canceled", { by: "user" }),
    ]);

    expect(chunks).toEqual([
      { type: "reasoning-delta", id: "reasoning_1", delta: " the launch" },
      { type: "reasoning-end", id: "reasoning_1" },
      { type: "abort", reason: "Canceled by the user." },
    ]);
    expect(projector.partsSnapshot).toEqual([
      { id: "reasoning_1", kind: "reasoning", text: "Thinking about the launch", done: true },
    ]);
    expect(projector.startedToolCallIds).toEqual(["tool_1"]);
  });

  it("ignores malformed persisted parts instead of throwing", () => {
    const projector = new HeadlessChatUiProjector("message_assistant_1", "not-an-array" as never);

    expect(
      project(projector, [presentation("text_1", "text", "p1:1786461536300-0", "Safe", 0)]).slice(
        0,
        1,
      ),
    ).toEqual([{ type: "text-start", id: "text_1" }]);
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

function partUpdated(
  sequence: number,
  partId: string,
  kind: "text" | "reasoning",
  order: number,
  state: "streaming" | "done",
  text: string,
) {
  return event(sequence, "message.part_updated", {
    messageId: "message_assistant_1",
    partId,
    kind,
    order,
    state,
    text,
  });
}

function presentation(
  partId: string,
  kind: "text" | "reasoning",
  presentationCursor: string,
  delta: string,
  startOffset: number,
) {
  return parseRunStreamEvent({
    runId: "run_1",
    attemptNumber: 1,
    presentationCursor,
    schemaVersion: 1,
    occurredAt,
    type: "message.presentation_delta",
    payload: {
      messageId: "message_assistant_1",
      partId,
      kind,
      startOffset,
      endOffset: startOffset + delta.length,
      delta,
    },
  });
}
