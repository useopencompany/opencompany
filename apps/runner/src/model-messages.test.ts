import { modelMessageSchema } from "ai";
import { describe, expect, it } from "vitest";
import {
  type AssistantReplayPart,
  appendAssistantTextPart,
  buildAssistantModelMessage,
  buildModelMessages,
  buildToolModelMessage,
  serializeToolOutputForStorage,
  toPersistedModelMessage,
} from "./model-messages";

describe("buildModelMessages", () => {
  it("sanitizes DB-hostile tool output before storage and model replay", () => {
    const output = {
      results: [
        {
          title: "Search result",
          highlights: ["before\u0000after\u0014tail\uD800"],
        },
      ],
    };

    const storedOutput = serializeToolOutputForStorage(output);
    expect(storedOutput).not.toContain("\\u0000");
    expect(storedOutput).not.toContain("\\u0014");
    expect(storedOutput).toContain("before\uFFFDafter\uFFFDtail\uFFFD");

    const tool = buildToolModelMessage({
      toolCallId: "call_search",
      toolName: "exa_search",
      output,
    });
    const persisted = JSON.stringify(toPersistedModelMessage(tool));

    expect(persisted).not.toContain("\\u0000");
    expect(persisted).not.toContain("\\u0014");
    expect(persisted).toContain("before�after�tail�");
    expect(modelMessageSchema.safeParse(tool).success).toBe(true);
  });

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

  it("pairs an assistant tool call with a tool result persisted by a later resume run", () => {
    // Suspend/resume splits one logical turn across two runner runs: the suspend run
    // persists the assistant message ending in the pending tool-call, and the resume run
    // (after approval) persists the tool-result. buildModelMessages reads ordered session
    // rows and is agnostic to which run wrote each row, so the pairing must still hold.
    const assistant = buildAssistantModelMessage({
      content: "I'll open the issue.",
      parts: [
        { type: "text", text: "I'll open the issue." },
        {
          type: "tool-call",
          toolCallId: "call_ask",
          toolName: "linear__create_issue",
          input: { title: "Bug" },
        },
      ],
    });
    const tool = buildToolModelMessage({
      toolCallId: "call_ask",
      toolName: "linear__create_issue",
      output: { id: "ISS-1" },
    });

    const messages = buildModelMessages([
      { id: "msg_user", role: "user", content: "Open an issue.", modelMessage: null },
      {
        id: "msg_assistant_suspended",
        role: "assistant",
        content: "I'll open the issue.",
        modelMessage: toPersistedModelMessage(assistant),
      },
      // Persisted by the resume run, not the suspend run.
      {
        id: "msg_tool_resumed",
        role: "tool",
        content: JSON.stringify({ id: "ISS-1" }),
        modelMessage: toPersistedModelMessage(tool),
      },
    ]);

    expect(messages).toEqual([{ role: "user", content: "Open an issue." }, assistant, tool]);
    expect(messages.every((message) => modelMessageSchema.safeParse(message).success)).toBe(true);
  });

  it("drops a still-suspended assistant tool call when no result is persisted yet", () => {
    // While suspended (or after an abort while paused) the assistant message ends in a
    // dangling tool-call with no tool-result. buildModelMessages strips that tool-call,
    // keeping the assistant text, so a later turn never sends the provider a tool_use with
    // no matching tool_result. (The normal resume path persists the result first, so the
    // tool-call is kept and paired.)
    const assistant = buildAssistantModelMessage({
      content: "I'll open the issue.",
      parts: [
        { type: "text", text: "I'll open the issue." },
        {
          type: "tool-call",
          toolCallId: "call_ask",
          toolName: "linear__create_issue",
          input: { title: "Bug" },
        },
      ],
    });

    const messages = buildModelMessages([
      { id: "msg_user", role: "user", content: "Open an issue.", modelMessage: null },
      {
        id: "msg_assistant_suspended",
        role: "assistant",
        content: "I'll open the issue.",
        modelMessage: toPersistedModelMessage(assistant),
      },
    ]);

    expect(messages).toEqual([
      { role: "user", content: "Open an issue." },
      { role: "assistant", content: "I'll open the issue." },
    ]);
  });

  it("preserves assistant reasoning parts when replaying tool-call turns", () => {
    const assistant = buildAssistantModelMessage({
      content: "Done.",
      parts: [
        { type: "reasoning", text: "Need to inspect the file first." },
        {
          type: "tool-call",
          toolCallId: "call_123",
          toolName: "read_file",
          input: { path: "README.md" },
        },
        { type: "text", text: "Done." },
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
        content: "Done.",
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
        content: "Continue.",
        modelMessage: { role: "user", content: "Continue." },
      },
    ]);

    expect(messages).toEqual([
      { role: "user", content: "Read the docs." },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Need to inspect the file first." },
          {
            type: "tool-call",
            toolCallId: "call_123",
            toolName: "read_file",
            input: { path: "README.md" },
          },
        ],
      },
      tool,
      { role: "assistant", content: "Done." },
      { role: "user", content: "Continue." },
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
      // The empty assistant row left by the failed turn is also dropped (empty-message replay
      // guard) — replaying it is what poisons later turns into repeated gateway 400s.
      { role: "user", content: "Continue." },
    ]);
  });

  it("replays tool results after an empty assistant message when its tool call was persisted", () => {
    const assistant = buildAssistantModelMessage({
      content: "",
      parts: [
        {
          type: "tool-call",
          toolCallId: "call_at_step_limit",
          toolName: "list_files",
          input: { path: "work" },
        },
      ],
    });
    const tool = buildToolModelMessage({
      toolCallId: "call_at_step_limit",
      toolName: "list_files",
      output: { entries: ["work/README.md"] },
    });

    expect(
      buildModelMessages([
        {
          id: "msg_user_1",
          role: "user",
          content: "Inspect the PR.",
          modelMessage: { role: "user", content: "Inspect the PR." },
        },
        {
          id: "msg_assistant_step_limit",
          role: "assistant",
          content: "",
          modelMessage: toPersistedModelMessage(assistant),
        },
        {
          id: "msg_tool_step_limit",
          role: "tool",
          content: JSON.stringify({ entries: ["work/README.md"] }),
          modelMessage: toPersistedModelMessage(tool),
        },
        {
          id: "msg_user_continue",
          role: "user",
          content: "Continue.",
          modelMessage: { role: "user", content: "Continue." },
        },
      ]),
    ).toEqual([
      { role: "user", content: "Inspect the PR." },
      assistant,
      tool,
      { role: "user", content: "Continue." },
    ]);
  });
});

describe("buildModelMessages with attachments", () => {
  const imageBase64 = Buffer.from("fake-png-bytes").toString("base64");
  const pdfBase64 = Buffer.from("fake-pdf-bytes").toString("base64");

  it("inlines an image attachment as a text part then an image part", () => {
    const messages = buildModelMessages([
      {
        id: "msg_user_image",
        role: "user",
        content: "What is in this screenshot?",
        modelMessage: { role: "user", content: "What is in this screenshot?" },
        attachments: [
          {
            kind: "image",
            mediaType: "image/png",
            filename: "screenshot.png",
            base64: imageBase64,
            blobPathname: "workspace/wsp_1/sessions/ses_1/att_1-screenshot.png",
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this screenshot?" },
          { type: "image", image: imageBase64, mediaType: "image/png" },
        ],
      },
    ]);
    expect(messages.every((message) => modelMessageSchema.safeParse(message).success)).toBe(true);
  });

  it("inlines a pdf attachment as a file part with the application/pdf media type", () => {
    const messages = buildModelMessages([
      {
        id: "msg_user_pdf",
        role: "user",
        content: "Summarize this document.",
        modelMessage: { role: "user", content: "Summarize this document." },
        attachments: [
          {
            kind: "pdf",
            mediaType: "application/pdf",
            filename: "report.pdf",
            base64: pdfBase64,
            blobPathname: "workspace/wsp_1/sessions/ses_1/att_2-report.pdf",
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Summarize this document." },
          {
            type: "file",
            data: pdfBase64,
            mediaType: "application/pdf",
            filename: "report.pdf",
          },
        ],
      },
    ]);
    expect(messages.every((message) => modelMessageSchema.safeParse(message).success)).toBe(true);
  });

  it("inlines a text attachment as a text part carrying the filename and decoded contents", () => {
    const textBase64 = Buffer.from("hello world").toString("base64");
    const messages = buildModelMessages([
      {
        id: "msg_user_text",
        role: "user",
        content: "Review these notes.",
        modelMessage: { role: "user", content: "Review these notes." },
        attachments: [
          {
            kind: "text",
            mediaType: "text/markdown",
            filename: "notes.md",
            base64: textBase64,
            blobPathname: "workspace/wsp_1/sessions/ses_1/att_3-notes.md",
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Review these notes." },
          { type: "text", text: '\n\nAttached file "notes.md":\n\nhello world' },
        ],
      },
    ]);
    expect(messages.every((message) => modelMessageSchema.safeParse(message).success)).toBe(true);
  });

  it("path-references an above-threshold text attachment instead of inlining it", () => {
    const line = "x".repeat(99) + "\n"; // 100 bytes per line
    const bigText = line.repeat(1024); // 100 KiB > ATTACHMENT_TEXT_INLINE_MAX_BYTES (64 KiB)
    const bigBase64 = Buffer.from(bigText).toString("base64");
    const messages = buildModelMessages([
      {
        id: "msg_user_big_text",
        role: "user",
        content: "Dig through this log.",
        modelMessage: { role: "user", content: "Dig through this log." },
        attachments: [
          {
            kind: "text",
            mediaType: "text/plain",
            filename: "server.log",
            base64: bigBase64,
            blobPathname: "workspace/wsp_1/sessions/ses_1/att_4-server.log",
          },
        ],
      },
    ]);

    expect(messages).toHaveLength(1);
    const content = messages[0]?.content as Array<{ type: string; text: string }>;
    expect(content[0]).toEqual({ type: "text", text: "Dig through this log." });
    const reference = content[1]?.text ?? "";
    // Path + stats are present; the full body is not.
    expect(reference).toContain('Attached file "server.log" (100 KB, 1025 lines)');
    expect(reference).toContain("work/attachments/att_4-server.log");
    expect(reference).toContain("Preview (first 2000 characters):");
    expect(reference.length).toBeLessThan(3_000);
    expect(messages.every((message) => modelMessageSchema.safeParse(message).success)).toBe(true);
  });

  it("keeps an attachment-free user message as plain text content", () => {
    const messages = buildModelMessages([
      {
        id: "msg_user_plain",
        role: "user",
        content: "Just text.",
        modelMessage: { role: "user", content: "Just text." },
      },
    ]);

    expect(messages).toEqual([{ role: "user", content: "Just text." }]);
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

  it("keeps AI SDK reasoning parts even without tools", () => {
    expect(
      buildAssistantModelMessage({
        content: "Done",
        parts: [
          { type: "reasoning", text: "Checked the constraints." },
          { type: "text", text: "Done" },
        ],
      }),
    ).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "Checked the constraints." },
        { type: "text", text: "Done" },
      ],
    });
  });
});

describe("buildModelMessages — empty-message replay guard", () => {
  // Regression for the Leo kimi-k2.5 session (ses_042d0e478d8649fcbd24): an image-only paste was
  // dropped (attachments unsupported), leaving an EMPTY user message that was persisted and then
  // replayed on every later turn. The Vercel AI Gateway rejects an empty message, so once that row
  // entered history every subsequent turn failed with "Bad Request" — including a later "Hallo".
  // The guard drops empty user/assistant messages at replay time, which both prevents the cascade
  // and recovers already-poisoned sessions (the empty row is simply not sent).

  it("drops an empty user message from the replayed history", () => {
    const messages = buildModelMessages([
      {
        id: "u1",
        role: "user",
        content: "Pricing?",
        modelMessage: { role: "user", content: "Pricing?" },
      },
      // Image-only paste → image ignored → empty message still persisted (export turn 259).
      { id: "u2", role: "user", content: "", modelMessage: { role: "user", content: "" } },
      {
        id: "u3",
        role: "user",
        content: "Hallo",
        modelMessage: { role: "user", content: "Hallo" },
      },
    ]);

    expect(messages).toEqual([
      { role: "user", content: "Pricing?" },
      { role: "user", content: "Hallo" },
    ]);
  });

  it("drops a whitespace-only user message", () => {
    const messages = buildModelMessages([
      {
        id: "u1",
        role: "user",
        content: "   \n  ",
        modelMessage: { role: "user", content: "   \n  " },
      },
      {
        id: "u2",
        role: "user",
        content: "Real question",
        modelMessage: { role: "user", content: "Real question" },
      },
    ]);
    expect(messages).toEqual([{ role: "user", content: "Real question" }]);
  });

  it("drops an empty assistant row left behind by a failed turn (legacy fallback)", () => {
    // A failed turn never persists a completion: the assistant row stays with modelMessage=null
    // and empty content, so legacyModelMessage materializes { role: 'assistant', content: '' }.
    const messages = buildModelMessages([
      { id: "u1", role: "user", content: "Hi", modelMessage: { role: "user", content: "Hi" } },
      { id: "a1", role: "assistant", content: "", modelMessage: null },
      {
        id: "u2",
        role: "user",
        content: "Still there?",
        modelMessage: { role: "user", content: "Still there?" },
      },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "user", content: "Still there?" },
    ]);
  });

  it("keeps non-empty messages untouched", () => {
    const messages = buildModelMessages([
      {
        id: "u1",
        role: "user",
        content: "Question",
        modelMessage: { role: "user", content: "Question" },
      },
      {
        id: "a1",
        role: "assistant",
        content: "Answer",
        modelMessage: { role: "assistant", content: "Answer" },
      },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
    ]);
  });
});
