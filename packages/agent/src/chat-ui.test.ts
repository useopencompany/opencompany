import { describe, expect, it } from "vitest";
import { toChatUiMessage } from "./chat-ui";

describe("persisted Chat UI parts", () => {
  it("preserves only encrypted Codex reasoning continuity metadata", () => {
    const message = toChatUiMessage({
      id: "message_1",
      sessionId: "session_1",
      role: "assistant",
      content: "Answer",
      taskId: null,
      taskDisplayId: null,
      taskName: null,
      taskPrompt: null,
      taskStatus: null,
      attachments: [],
      attachmentTexts: [],
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
      debugTrace: {
        schemaVersion: "opencompany.chat.debug.v1",
        model: "openai/gpt-5.6-sol",
        uiMessageParts: [
          {
            type: "reasoning",
            text: "Summary",
            providerMetadata: {
              codex: { encryptedContent: "encrypted-continuity", ignored: "strip-me" },
              untrustedProvider: { secret: "strip-me" },
            },
          },
          { type: "text", text: "Answer" },
        ],
      },
    } as never);

    expect(message.parts[0]).toEqual({
      type: "reasoning",
      text: "Summary",
      state: "done",
      providerMetadata: { codex: { encryptedContent: "encrypted-continuity" } },
    });
  });
});
