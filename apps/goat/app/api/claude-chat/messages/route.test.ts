import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoatAuthContext } from "@/lib/auth";
import { currentGoatUser } from "@/lib/auth";
import { createGoatCodexChatMessage } from "@/lib/codex-chat";
import { GoatSkillMentionError, resolveGoatSkillMentions } from "@/lib/skills";
import { POST } from "./route";

const analyticsMocks = vi.hoisted(() => ({
  captureGoatServerEvent: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/analytics/goat/server", () => ({
  captureGoatServerEvent: analyticsMocks.captureGoatServerEvent,
}));

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

describe("POST /api/claude-chat/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentGoatUser).mockResolvedValue({
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
    vi.mocked(createGoatCodexChatMessage).mockResolvedValue({
      ok: true,
      sessionId: "goat_chat_1",
      userMessageId: "goat_chat_msg_user",
      assistantMessageId: "goat_chat_msg_assistant",
      mode: "started",
      analytics: {
        isFirstMessage: true,
        engine: "claude_code",
        model: "anthropic/claude-opus-4.8",
      },
    });
    vi.mocked(resolveGoatSkillMentions).mockResolvedValue([]);
  });

  it("resolves workspace skills and queues the Claude engine", async () => {
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
        model: "anthropic/claude-opus-4.8",
        settings: { reasoningEffort: "xhigh" },
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      sessionId: "goat_chat_1",
      userMessageId: "goat_chat_msg_user",
      assistantMessageId: "goat_chat_msg_assistant",
      mode: "started",
    });
    expect(resolveGoatSkillMentions).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      mentions: [{ id: "coding-work" }],
    });
    expect(createGoatCodexChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        engine: "claude_code",
        prompt: "Implement this",
        model: "anthropic/claude-opus-4.8",
        settings: { reasoningEffort: "xhigh" },
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
    expect(analyticsMocks.captureGoatServerEvent).toHaveBeenCalledWith(
      "chat_message_sent",
      "user_1",
      {
        workspace_id: "workspace_1",
        session_id: "goat_chat_1",
        is_first_message: true,
        engine: "claude_code",
        model: "anthropic/claude-opus-4.8",
        message_length: 14,
      },
      {
        workspaceId: "workspace_1",
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
      },
    );
  });

  it("rejects stale workspace skills before queueing", async () => {
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
    expect(createGoatCodexChatMessage).not.toHaveBeenCalled();
    expect(analyticsMocks.captureGoatServerEvent).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: unknown) {
  return new Request("https://goat.test/api/claude-chat/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}
