import { parseCodexChatSettings } from "@opencompany/core/codex-chat-settings";
import { describe, expect, it } from "vitest";

describe("parseCodexChatSettings", () => {
  it("defaults sandboxed Codex chats to xhigh reasoning", () => {
    expect(parseCodexChatSettings(undefined)).toEqual({
      ok: true,
      settings: { reasoningEffort: "xhigh" },
    });
  });
});
