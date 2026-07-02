import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { GOAT_CHAT_PROMPT_MAX_LENGTH } from "@/lib/chat-validation";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

describe("POST /api/chat", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "test-key");
  });

  it("rejects unauthenticated requests", async () => {
    mockCurrentGoatUser().mockResolvedValue(null);

    const response = await POST(jsonRequest({}));

    expect(response.status).toBe(401);
  });

  it("rejects malformed chat messages", async () => {
    mockAuth();

    const response = await POST(jsonRequest({ message: { role: "assistant" } }));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid chat message.");
  });

  it("rejects oversized messages before model streaming", async () => {
    mockAuth();

    const response = await POST(
      jsonRequest({
        model: "openai/gpt-5.4-mini",
        message: {
          id: "ui_user_1",
          role: "user",
          parts: [{ type: "text", text: "x".repeat(GOAT_CHAT_PROMPT_MAX_LENGTH + 1) }],
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("Messages can be at most");
  });
});

function jsonRequest(body: unknown) {
  return new Request("https://goat.test/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function mockAuth() {
  mockCurrentGoatUser().mockResolvedValue({
    authUser: {
      id: "user_1",
      email: "user@example.com",
    } as never,
    user: {
      workosUserId: "user_1",
      email: "user@example.com",
      firstName: null,
      lastName: null,
      avatarUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

function mockCurrentGoatUser() {
  return vi.mocked(currentGoatUser as unknown as () => Promise<unknown>);
}
