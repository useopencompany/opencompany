import { modelMessageSchema } from "ai";
import { describe, expect, it } from "vitest";
import {
  type AssistantReplayPart,
  appendAssistantTextPart,
  buildAssistantModelMessage,
  buildModelMessages,
  buildToolModelMessage,
  toPersistedModelMessage,
} from "./model-messages";

describe("buildModelMessages", () => {
  it("replays assistant tool calls and matching tool results for follow-up turns", () => {
    const assistant = buildAssistantModelMessage({
      content: "Checking.",
      parts: [
        { type: "text", text: "Checking." },
        {
          type: "tool-call",
          toolCallId: "call_123",
          toolName: "read_file",
          input: { path: "README.md" },
        },
      ],
    });
    const tool = buildToolModelMessage({
      toolCallId: "call_123",
      toolName: "read_file",
      output: { content: "Project docs" },
    });

    const messages = buildModelMessages([
      {
        id: "msg_user_1",
        role: "user",
        content: "Read the docs.",
        modelMessage: { role: "user", content: "Read the docs." },
      },
      {
        id: "msg_assistant_1",
        role: "assistant",
        content: "Checking.",
        modelMessage: toPersistedModelMessage(assistant),
      },
      {
        id: "msg_tool_1",
        role: "tool",
        content: JSON.stringify({ content: "Project docs" }),
        modelMessage: toPersistedModelMessage(tool),
      },
      {
        id: "msg_user_2",
        role: "user",
        content: "What did it say?",
        modelMessage: { role: "user", content: "What did it say?" },
      },
    ]);

    expect(messages).toEqual([
      { role: "user", content: "Read the docs." },
      assistant,
      tool,
      { role: "user", content: "What did it say?" },
    ]);
    expect(messages.every((message) => modelMessageSchema.safeParse(message).success)).toBe(true);
  });

  it("splits assistant text after tool calls so tool results replay immediately after tool use", () => {
    const assistant = buildAssistantModelMessage({
      content: "Done.",
      parts: [
        {
          type: "tool-call",
          toolCallId: "call_123",
          toolName: "write_file",
          input: { path: "hello.txt", content: "Hello" },
        },
        { type: "text", text: "Done." },
      ],
    });
    const tool = buildToolModelMessage({
      toolCallId: "call_123",
      toolName: "write_file",
      output: { path: "hello.txt", bytes: 5 },
    });

    const messages = buildModelMessages([
      {
        id: "msg_user_1",
        role: "user",
        content: "Write hello.",
        modelMessage: { role: "user", content: "Write hello." },
      },
      {
        id: "msg_assistant_1",
        role: "assistant",
        content: "Done.",
        modelMessage: toPersistedModelMessage(assistant),
      },
      {
        id: "msg_tool_1",
        role: "tool",
        content: JSON.stringify({ path: "hello.txt", bytes: 5 }),
        modelMessage: toPersistedModelMessage(tool),
      },
      {
        id: "msg_user_2",
        role: "user",
        content: "Nice.",
        modelMessage: { role: "user", content: "Nice." },
      },
    ]);

    expect(messages).toEqual([
      { role: "user", content: "Write hello." },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_123",
            toolName: "write_file",
            input: { path: "hello.txt", content: "Hello" },
          },
        ],
      },
      tool,
      { role: "assistant", content: "Done." },
      { role: "user", content: "Nice." },
    ]);
    expect(messages.every((message) => modelMessageSchema.safeParse(message).success)).toBe(true);
  });

  it("falls back to basic text history for legacy rows without model messages", () => {
    expect(
      buildModelMessages([
        { id: "msg_user", role: "user", content: "Hi", modelMessage: null },
        { id: "msg_assistant", role: "assistant", content: "Hello", modelMessage: null },
        {
          id: "msg_tool",
          role: "tool",
          content: JSON.stringify({ ok: true }),
          modelMessage: null,
        },
      ]),
    ).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("drops orphan persisted tool results that are not paired with assistant tool calls", () => {
    const tool = buildToolModelMessage({
      toolCallId: "call_orphan",
      toolName: "list_files",
      output: { entries: [] },
    });

    expect(
      buildModelMessages([
        {
          id: "msg_user_1",
          role: "user",
          content: "List files.",
          modelMessage: { role: "user", content: "List files." },
        },
        {
          id: "msg_assistant_failed",
          role: "assistant",
          content: "",
          modelMessage: null,
        },
        {
          id: "msg_tool_orphan",
          role: "tool",
          content: JSON.stringify({ entries: [] }),
          modelMessage: toPersistedModelMessage(tool),
        },
        {
          id: "msg_user_2",
          role: "user",
          content: "Continue.",
          modelMessage: { role: "user", content: "Continue." },
        },
      ]),
    ).toEqual([
      { role: "user", content: "List files." },
      { role: "assistant", content: "" },
      { role: "user", content: "Continue." },
    ]);
  });
});

describe("buildAssistantModelMessage", () => {
  it("uses text content for text-only assistant messages", () => {
    expect(
      buildAssistantModelMessage({ content: "Done", parts: [{ type: "text", text: "Done" }] }),
    ).toEqual({ role: "assistant", content: "Done" });
  });

  it("keeps AI SDK tool-call parts when tools are present", () => {
    const parts: AssistantReplayPart[] = [];
    appendAssistantTextPart(parts, "A");
    appendAssistantTextPart(parts, "B");
    parts.push({
      type: "tool-call",
      toolCallId: "call_abc",
      toolName: "list_files",
      input: {},
    });

    expect(buildAssistantModelMessage({ content: "AB", parts })).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "AB" },
        { type: "tool-call", toolCallId: "call_abc", toolName: "list_files", input: {} },
      ],
    });
  });
});
