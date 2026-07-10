import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoatAuthContext } from "@/lib/auth";
import { currentGoatUser } from "@/lib/auth";
import { createGoatCodexChatMessage } from "@/lib/codex-chat";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/codex-chat", () => ({
  createGoatCodexChatMessage: vi.fn(),
}));

describe("POST /api/codex-chat/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentGoatUser().mockResolvedValue({
      user: {
        workosUserId: "user_1",
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: null,
        timezone: "UTC",
        localCodexBetaEnabled: false,
        createdAt: new Date("2026-07-10T00:00:00.000Z"),
        updatedAt: new Date("2026-07-10T00:00:00.000Z"),
      },
    } as GoatAuthContext);
    mockCreateGoatCodexChatMessage().mockResolvedValue({
      ok: true,
      sessionId: "goat_chat_1",
      userMessageId: "goat_chat_msg_user",
      assistantMessageId: "goat_chat_msg_assistant",
      mode: "started",
    });
  });

  it("rejects malformed JSON shapes", async () => {
    const response = await POST(jsonRequest(null));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid Codex chat message.");
    expect(mockCreateGoatCodexChatMessage()).not.toHaveBeenCalled();
  });

  it("accepts UI message payloads", async () => {
    const response = await POST(
      jsonRequest({
        sessionId: "goat_chat_1",
        message: {
          id: "client_msg_1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(mockCreateGoatCodexChatMessage()).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      sessionId: "goat_chat_1",
      prompt: "hello",
      clientMessageId: "client_msg_1",
    });
  });
});

function jsonRequest(body: unknown) {
  return new Request("https://goat.test/api/codex-chat/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function mockCurrentGoatUser() {
  return vi.mocked(currentGoatUser);
}

function mockCreateGoatCodexChatMessage() {
  return vi.mocked(createGoatCodexChatMessage);
}
