import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
}));

vi.mock("@/lib/codex-chat", () => ({
  createCodexChatMessage: mocks.createMessage,
}));

describe("POST /api/internal/opencompany-chat/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "shared-secret");
    mocks.createMessage.mockResolvedValue({
      ok: true,
      sessionId: "goat_chat_1",
      userMessageId: "goat_chat_msg_user",
      assistantMessageId: "goat_chat_msg_assistant",
      mode: "started",
      analytics: {
        isFirstMessage: true,
        engine: "opencompany",
        model: "anthropic/claude-sonnet-5",
      },
    });
  });

  it("rejects callers without the internal bearer token", async () => {
    const response = await POST(request({ bearer: "wrong-token" }));

    expect(response.status).toBe(401);
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });

  it("enqueues an internal OpenCompany turn through the durable queue", async () => {
    const response = await POST(
      request({
        bearer: "shared-secret",
        body: {
          userWorkosId: "user_1",
          workspaceId: "workspace_1",
          brainRef: "brain_1",
          prompt: "Summarize the launch notes",
          model: "anthropic/claude-sonnet-5",
        },
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sessionId: "goat_chat_1",
      mode: "started",
    });
    expect(mocks.createMessage).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      brainRef: "brain_1",
      prompt: "Summarize the launch notes",
      model: "anthropic/claude-sonnet-5",
      engine: "opencompany",
    });
  });

  it("rejects ambiguous new and existing session targets", async () => {
    const response = await POST(
      request({
        bearer: "shared-secret",
        body: {
          userWorkosId: "user_1",
          workspaceId: "workspace_1",
          prompt: "Continue",
          sessionId: "goat_chat_existing",
          newSessionId: "goat_chat_new",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });
});

function request(input: { bearer?: string; body?: Record<string, unknown> }) {
  return new Request("https://goat.opencompany.test/api/internal/opencompany-chat/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.bearer ? { authorization: `Bearer ${input.bearer}` } : {}),
    },
    body: JSON.stringify(
      input.body ?? {
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        prompt: "Hello",
      },
    ),
  });
}
