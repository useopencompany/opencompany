import { describe, expect, it } from "vitest";
import { parseClaudeChatSettings } from "@/lib/claude-chat-settings";

describe("parseClaudeChatSettings", () => {
  it("defaults Claude chats to high reasoning effort", () => {
    expect(parseClaudeChatSettings(undefined)).toEqual({
      ok: true,
      settings: { reasoningEffort: "high" },
    });
  });

  it("accepts the reasoning levels supported by the composer", () => {
    expect(parseClaudeChatSettings({ reasoningEffort: "xhigh" })).toEqual({
      ok: true,
      settings: { reasoningEffort: "xhigh" },
    });
  });

  it("rejects invalid reasoning effort", () => {
    expect(parseClaudeChatSettings({ reasoningEffort: "max" })).toEqual({
      ok: false,
      error: "Invalid Claude reasoning effort.",
    });
  });
});
