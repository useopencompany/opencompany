import { describe, expect, it } from "vitest";
import { parseCodexChatSettings } from "@/lib/codex-chat-settings";

describe("parseCodexChatSettings", () => {
  it("defaults sandboxed Codex chats to xhigh reasoning", () => {
    expect(parseCodexChatSettings(undefined)).toEqual({
      ok: true,
      settings: { reasoningEffort: "xhigh" },
    });
  });
});
