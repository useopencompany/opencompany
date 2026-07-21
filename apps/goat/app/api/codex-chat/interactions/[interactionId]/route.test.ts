import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoatAuthContext } from "@/lib/auth";
import { currentGoatUser } from "@/lib/auth";
import { resolveGoatCodexChatInteraction } from "@/lib/codex-chat-interactions";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({ currentGoatUser: vi.fn() }));
vi.mock("@/lib/codex-chat-interactions", () => ({
  resolveGoatCodexChatInteraction: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { "Content-Type": "application/json", ...init?.headers },
      }),
  },
}));

const interactionId = "goat_codex_chat_interaction_123e4567-e89b-12d3-a456-426614174000";

describe("POST /api/codex-chat/interactions/[interactionId]", () => {
  beforeEach(() => {
    vi.mocked(currentGoatUser).mockResolvedValue({
      user: { workosUserId: "user_1" },
    } as GoatAuthContext);
    vi.mocked(resolveGoatCodexChatInteraction).mockResolvedValue({
      ok: true,
      response: { answers: { scope: { answers: ["Foundational"] } } },
    });
  });

  it("authenticates and forwards the scoped answer", async () => {
    const answers = { scope: { answers: ["Foundational"] } };
    const response = await POST(jsonRequest({ answers }), {
      params: Promise.resolve({ interactionId }),
    });

    expect(response.status).toBe(202);
    expect(resolveGoatCodexChatInteraction).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      interactionId,
      answers,
    });
  });

  it("rejects unauthenticated and malformed interaction requests", async () => {
    vi.mocked(currentGoatUser).mockResolvedValueOnce(null as never);
    const unauthorized = await POST(jsonRequest({ answers: {} }), {
      params: Promise.resolve({ interactionId }),
    });
    expect(unauthorized.status).toBe(401);

    const malformed = await POST(jsonRequest({ answers: {} }), {
      params: Promise.resolve({ interactionId: "not-an-interaction" }),
    });
    expect(malformed.status).toBe(404);
    expect(resolveGoatCodexChatInteraction).not.toHaveBeenCalled();
  });

  it("preserves stale-question conflicts from the durable resolver", async () => {
    vi.mocked(resolveGoatCodexChatInteraction).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "This Codex question is no longer waiting.",
    });
    const response = await POST(jsonRequest({ answers: {} }), {
      params: Promise.resolve({ interactionId }),
    });
    expect(response.status).toBe(409);
  });
});

function jsonRequest(body: unknown) {
  return new Request(`http://localhost/api/codex-chat/interactions/${interactionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
