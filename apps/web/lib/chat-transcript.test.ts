import { describe, expect, it } from "vitest";
import type { GoatChatUiMessage } from "@/lib/chat-ui";
import { composeChatTranscript } from "./chat-transcript";

describe("composeChatTranscript", () => {
  it("keeps persisted reasoning when a later turn is streaming", () => {
    const persisted = [
      assistant("assistant_1", [
        { type: "reasoning", text: "Inspecting the repository.", state: "done" },
        { type: "text", text: "First answer." },
      ]),
      user("user_2", "Follow up"),
      assistant("assistant_2", [
        { type: "reasoning", text: "Checking the follow-up.", state: "done" },
        { type: "text", text: "Partial" },
      ]),
    ];
    const transient = [
      assistant("assistant_1", [{ type: "text", text: "First answer." }]),
      user("user_2", "Follow up"),
      assistant("assistant_2", [{ type: "text", text: "Partial response" }]),
    ];

    const result = composeChatTranscript({
      persistedMessages: persisted,
      transientMessages: transient,
      streaming: true,
    });

    expect(result[0]).toBe(persisted[0]);
    expect(result[0]?.parts[0]).toMatchObject({
      type: "reasoning",
      text: "Inspecting the repository.",
    });
    expect(result[2]?.parts).toEqual([
      { type: "reasoning", text: "Checking the follow-up.", state: "done" },
      { type: "text", text: "Partial" },
      { type: "text", text: " response" },
    ]);
  });

  it("appends transient tools and text without degrading persisted tool details", () => {
    const persistedTool = {
      type: "dynamic-tool" as const,
      toolName: "use_action",
      toolCallId: "tool_1",
      state: "output-available" as const,
      input: { action: "calendar.create", arguments: { title: "Planning" } },
      output: { ok: true, result: { eventId: "event_1" } },
    };
    const persisted = assistant("assistant_1", [
      { type: "reasoning", text: "Preparing the event.", state: "done" },
      { type: "text", text: "Working" },
      persistedTool,
    ]);
    const transient = assistant("assistant_1", [
      { type: "text", text: "Working" },
      {
        type: "dynamic-tool",
        toolName: "use_action",
        toolCallId: "tool_1",
        state: "output-available",
        input: {},
        output: { ok: true },
      },
      {
        type: "dynamic-tool",
        toolName: "send_user_message",
        toolCallId: "tool_2",
        state: "input-available",
        input: { message: "Done" },
      },
      { type: "text", text: " done" },
    ]);

    const [result] = composeChatTranscript({
      persistedMessages: [persisted],
      transientMessages: [transient],
      streaming: true,
    });

    expect(result?.parts).toEqual([
      { type: "reasoning", text: "Preparing the event.", state: "done" },
      { type: "text", text: "Working" },
      persistedTool,
      expect.objectContaining({ toolCallId: "tool_2" }),
      { type: "text", text: " done" },
    ]);
  });

  it("keeps transient-only optimistic messages in their original order", () => {
    const persisted = user("user_1", "Earlier");
    const optimisticUser = user("user_2", "New question");
    const optimisticAssistant = assistant("assistant_2", [{ type: "text", text: "Starting" }]);

    expect(
      composeChatTranscript({
        persistedMessages: [persisted],
        transientMessages: [persisted, optimisticUser, optimisticAssistant],
        streaming: true,
      }),
    ).toEqual([persisted, optimisticUser, optimisticAssistant]);
  });

  it("never augments history while the active assistant is still transient-only", () => {
    const persisted = assistant("assistant_1", [
      { type: "reasoning", text: "Durable reasoning", state: "done" },
      { type: "text", text: "Earlier answer" },
    ]);
    const active = assistant("assistant_2", [{ type: "text", text: "Starting" }]);

    const result = composeChatTranscript({
      persistedMessages: [persisted],
      transientMessages: [
        assistant("assistant_1", [{ type: "text", text: "Earlier answer stale tail" }]),
        active,
      ],
      streaming: true,
    });

    expect(result).toEqual([persisted, active]);
    expect(result[0]).toBe(persisted);
  });

  it("does not append divergent transient text over canonical content", () => {
    const persisted = assistant("assistant_1", [
      { type: "reasoning", text: "Durable reasoning", state: "done" },
      { type: "text", text: "Canonical answer" },
    ]);

    const [result] = composeChatTranscript({
      persistedMessages: [persisted],
      transientMessages: [
        assistant("assistant_1", [{ type: "text", text: "Stale transient answer" }]),
      ],
      streaming: true,
    });

    expect(result).toBe(persisted);
  });
});

function assistant(id: string, parts: GoatChatUiMessage["parts"]): GoatChatUiMessage {
  return { id, role: "assistant", parts };
}

function user(id: string, text: string): GoatChatUiMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}
