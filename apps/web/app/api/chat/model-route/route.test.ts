import { AutoModelRoutingError } from "@opencompany/goat-agent/application/auto-model-routing";
import { resolvePersistedAutoModelRouting } from "@opencompany/goat-agent/application/persisted-auto-model-routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGoatChatRequestContext } from "@/lib/chat-request-auth";
import { POST } from "./route";

vi.mock("@/lib/chat-request-auth", () => ({
  resolveGoatChatRequestContext: vi.fn(),
}));

vi.mock("@opencompany/goat-agent/application/persisted-auto-model-routing", () => ({
  resolvePersistedAutoModelRouting: vi.fn(),
}));

describe("POST /api/chat/model-route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "gateway-key");
    vi.mocked(resolveGoatChatRequestContext).mockResolvedValue({
      ok: true,
      context: {
        user: {
          workosUserId: "user_1",
          autoModelRoutingEnabled: true,
        },
        workspace: { id: "workspace_1" },
      },
    } as never);
    vi.mocked(resolvePersistedAutoModelRouting).mockResolvedValue({
      model: "moonshotai/kimi-k2.6",
      source: "routed",
      routing: {
        model: "moonshotai/kimi-k2.6",
        tier: "standard",
        reason: "simple_answer",
        classifier: {
          model: "google/gemini-3.1-flash-lite",
          outcome: "success",
          durationMs: 12,
        },
      },
    });
  });

  it("routes from host-verified identity and unclaimed attachment formats", async () => {
    const response = await POST(
      request({
        clientMessageId: "message_1",
        prompt: "Summarize this",
        attachmentIds: ["attachment_1"],
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: "moonshotai/kimi-k2.6",
      tier: "standard",
    });
    expect(resolvePersistedAutoModelRouting).toHaveBeenCalledWith({
      actorId: "user_1",
      workspaceId: "workspace_1",
      idempotencyKey: "web-message:message_1",
      clientMessageId: "message_1",
      prompt: "Summarize this",
      attachmentIds: ["attachment_1"],
      gatewayApiKey: "gateway-key",
    });
  });

  it("reuses the persisted model when an Auto command retries after commit", async () => {
    vi.mocked(resolvePersistedAutoModelRouting).mockResolvedValue({
      model: "anthropic/claude-sonnet-5",
      source: "idempotency_replay",
    });
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "");

    const response = await POST(
      request({
        clientMessageId: "message_committed",
        prompt: "Summarize this",
        attachmentIds: ["attachment_already_claimed"],
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: "anthropic/claude-sonnet-5",
      outcome: "replayed",
    });
    expect(resolvePersistedAutoModelRouting).toHaveBeenCalledOnce();
  });

  it("fails closed when an attachment is not owned and available in the active workspace", async () => {
    vi.mocked(resolvePersistedAutoModelRouting).mockRejectedValue(
      new AutoModelRoutingError(
        "attachments_unavailable",
        "One or more attachments are unavailable.",
      ),
    );
    const response = await POST(
      request({
        clientMessageId: "message_1",
        prompt: "Summarize this",
        attachmentIds: ["attachment_other"],
      }),
    );

    expect(response.status).toBe(400);
  });

  it("honors the per-user Auto routing gate", async () => {
    vi.mocked(resolvePersistedAutoModelRouting).mockRejectedValue(
      new AutoModelRoutingError("disabled", "Auto model routing is not enabled."),
    );

    const response = await POST(
      request({ clientMessageId: "message_1", prompt: "Hello", attachmentIds: [] }),
    );

    expect(response.status).toBe(403);
  });
});

function request(body: Record<string, unknown>) {
  return new Request("https://goat.example.com/api/chat/model-route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
