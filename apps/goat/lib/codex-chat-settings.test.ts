import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_CODEX_CHAT_REASONING_EFFORT,
  parseCodexChatSettings,
} from "@/lib/codex-chat-settings";

describe("parseCodexChatSettings", () => {
  it("defaults sandboxed Codex chats to xhigh reasoning", () => {
    expect(parseCodexChatSettings(undefined)).toEqual({
      ok: true,
      settings: { reasoningEffort: "xhigh" },
    });
  });

  it("keeps the local Codex default at medium reasoning", () => {
    expect(parseCodexChatSettings(undefined, DEFAULT_LOCAL_CODEX_CHAT_REASONING_EFFORT)).toEqual({
      ok: true,
      settings: { reasoningEffort: "medium" },
    });
  });
});
