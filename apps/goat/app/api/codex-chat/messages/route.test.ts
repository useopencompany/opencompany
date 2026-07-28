import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoatAuthContext } from "@/lib/auth";
import { currentGoatUser } from "@/lib/auth";
import { generateGoatChatTitleForMessage } from "@/lib/chat-title";
import { createGoatCodexChatMessage } from "@/lib/codex-chat";
import { GoatSkillMentionError, resolveGoatSkillMentions } from "@/lib/skills";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/codex-chat", () => ({
  createGoatCodexChatMessage: vi.fn(),
}));

vi.mock("@/lib/chat-title", () => ({
  generateGoatChatTitleForMessage: vi.fn(async () => ({ ok: true, title: "Generated title" })),
}));

vi.mock("@/lib/skills", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/skills")>();
  return { ...actual, resolveGoatSkillMentions: vi.fn() };
});

vi.mock("next/server", () => ({
  after: vi.fn((work: Promise<unknown>) => work),
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { "Content-Type": "application/json", ...init?.headers },
      }),
  },
}));

describe("POST /api/codex-chat/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "test-key");
    mockCurrentGoatUser().mockResolvedValue({
      user: {
        workosUserId: "user_1",
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: null,
        timezone: "UTC",
        taskSpawningEnabled: false,
        localCodexBetaEnabled: false,
        createdAt: new Date("2026-07-10T00:00:00.000Z"),
        updatedAt: new Date("2026-07-10T00:00:00.000Z"),
      },
      workspace: { id: "workspace_1" },
      activeBrain: { id: "goat_brain_1" },
    } as GoatAuthContext);
    mockCreateGoatCodexChatMessage().mockResolvedValue({
      ok: true,
      sessionId: "goat_chat_1",
      userMessageId: "goat_chat_msg_user",
      assistantMessageId: "goat_chat_msg_assistant",
      mode: "started",
    });
    vi.mocked(resolveGoatSkillMentions).mockResolvedValue([]);
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
      workspaceId: "workspace_1",
      brainRef: "goat_brain_1",
      sessionId: "goat_chat_1",
      prompt: "hello",
      skills: [],
      attachments: [],
      clientMessageId: "client_msg_1",
      settings: undefined,
    });
    expect(mockGenerateGoatChatTitleForMessage()).not.toHaveBeenCalled();
  });

  it("forwards a valid browser-reserved id for a new chat", async () => {
    const newSessionId = "goat_chat_123e4567-e89b-42d3-a456-426614174000";
    const response = await POST(
      jsonRequest({
        newSessionId,
        message: {
          id: "client_msg_1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(mockCreateGoatCodexChatMessage()).toHaveBeenCalledWith(
      expect.objectContaining({ newSessionId }),
    );
  });

  it("rejects an invalid browser-reserved id", async () => {
    const response = await POST(
      jsonRequest({
        newSessionId: "goat_chat_invalid",
        message: { role: "user", parts: [{ type: "text", text: "hello" }] },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid new chat session id.");
    expect(mockCreateGoatCodexChatMessage()).not.toHaveBeenCalled();
  });

  it("validates and forwards uploaded files, including attachment-only messages", async () => {
    const response = await POST(
      jsonRequest({
        message: {
          id: "client_msg_attachment",
          role: "user",
          parts: [{ type: "text", text: "" }],
          metadata: {
            attachments: [
              {
                id: "untrusted-client-id",
                kind: "image",
                mediaType: "image/png",
                filename: "screenshot.png",
                sizeBytes: 1024,
                blobUrl: "https://blob.test/goat-chat/user_1/screenshot.png",
                blobPathname: "ignored/client/path.png",
              },
            ],
          },
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(mockCreateGoatCodexChatMessage()).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "",
        attachments: [
          expect.objectContaining({
            id: expect.stringMatching(/^goat_chat_att_/),
            kind: "image",
            filename: "screenshot.png",
            blobPathname: "goat-chat/user_1/screenshot.png",
          }),
        ],
      }),
    );
    expect(mockGenerateGoatChatTitleForMessage()).not.toHaveBeenCalled();
  });

  it("forwards the selected model for a new Codex sandbox", async () => {
    const response = await POST(
      jsonRequest({
        prompt: "hello",
        model: "openai/gpt-5.6-luna",
      }),
    );

    expect(response.status).toBe(202);
    expect(mockCreateGoatCodexChatMessage()).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openai/gpt-5.6-luna" }),
    );
  });

  it("schedules LLM title generation for new Codex chats", async () => {
    const response = await POST(
      jsonRequest({
        prompt: "can you investigate why the deploy keeps timing out and summarize the likely fix?",
      }),
    );

    expect(response.status).toBe(202);
    expect(mockGenerateGoatChatTitleForMessage()).toHaveBeenCalledWith({
      sessionId: "goat_chat_1",
      messageId: "goat_chat_msg_user",
      apiKey: "test-key",
    });
  });

  it("forwards a validated skill snapshot for native session activation", async () => {
    vi.mocked(resolveGoatSkillMentions).mockResolvedValue([
      {
        id: "coding-work",
        name: "Coding work",
        description: "How coding work should happen.",
        instructions: "Inspect, implement, and verify.",
      },
    ]);
    const response = await POST(
      jsonRequest({
        message: {
          id: "client_msg_skill",
          role: "user",
          parts: [{ type: "text", text: "Implement this" }],
          metadata: {
            mentions: [{ kind: "skill", id: "coding-work" }],
          },
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(mockCreateGoatCodexChatMessage()).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Implement this",
        skills: [
          {
            id: "coding-work",
            brainRef: "workspace_1",
            name: "Coding work",
            description: "How coding work should happen.",
            instructions: "Inspect, implement, and verify.",
          },
        ],
      }),
    );
  });

  it("rejects stale structured skill references before queueing", async () => {
    vi.mocked(resolveGoatSkillMentions).mockRejectedValue(
      new GoatSkillMentionError("Skill is unavailable."),
    );
    const response = await POST(
      jsonRequest({
        prompt: "Implement this",
        message: {
          role: "user",
          parts: [{ type: "text", text: "Implement this" }],
          metadata: {
            mentions: [{ kind: "skill", id: "missing" }],
          },
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Skill is unavailable.");
    expect(mockCreateGoatCodexChatMessage()).not.toHaveBeenCalled();
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

function mockGenerateGoatChatTitleForMessage() {
  return vi.mocked(generateGoatChatTitleForMessage);
}
