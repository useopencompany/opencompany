import { describe, expect, it } from "vitest";
import { newOptimisticChatSessionId, parseOptimisticChatSessionId } from "@/lib/chat-navigation";

describe("parseOptimisticChatSessionId", () => {
  it("reserves canonical conversation IDs for browser-created chats", () => {
    const sessionId = newOptimisticChatSessionId();
    expect(sessionId).toMatch(/^conversation_/u);
    expect(parseOptimisticChatSessionId(sessionId)).toEqual({ ok: true, sessionId });
  });

  it("accepts canonical conversation UUIDs", () => {
    const sessionId = "conversation_123e4567-e89b-42d3-a456-426614174000";
    expect(parseOptimisticChatSessionId(sessionId)).toEqual({ ok: true, sessionId });
  });

  it("accepts browser-reserved opencompany chat UUIDs", () => {
    expect(parseOptimisticChatSessionId("goat_chat_123e4567-e89b-42d3-a456-426614174000")).toEqual({
      ok: true,
      sessionId: "goat_chat_123e4567-e89b-42d3-a456-426614174000",
    });
  });

  it.each(["chat_123", "goat_chat_not-a-uuid", 123])("rejects invalid ids: %s", (value) => {
    expect(parseOptimisticChatSessionId(value)).toEqual({
      ok: false,
      error: "Invalid new chat session id.",
    });
  });
});
