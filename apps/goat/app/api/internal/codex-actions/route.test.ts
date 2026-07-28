import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeGoatCodexActionGateway } from "@/lib/codex-actions";
import { POST } from "./route";

vi.mock("@/lib/codex-actions", () => ({
  executeGoatCodexActionGateway: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
      }),
  },
}));

describe("POST /api/internal/codex-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "shared-secret");
    vi.mocked(executeGoatCodexActionGateway).mockResolvedValue({
      ok: true,
      sources: [],
    });
  });

  it("rejects requests without the shared runner bearer", async () => {
    const response = await POST(request({ operation: "list" }));

    expect(response.status).toBe(401);
    expect(executeGoatCodexActionGateway).not.toHaveBeenCalled();
  });

  it("accepts only bounded host identity fields", async () => {
    const response = await POST(
      request(
        {
          operation: "execute",
          codexChatSessionId: "session_1",
          codexChatTurnId: "turn_1",
          action: "gmail.search",
          params: { query: "from:ada" },
          toolCallId: "call_1",
          userWorkosId: "untrusted",
          workspaceId: "untrusted",
        },
        "shared-secret",
      ),
    );

    expect(response.status).toBe(200);
    expect(executeGoatCodexActionGateway).toHaveBeenCalledWith({
      request: {
        operation: "execute",
        codexChatSessionId: "session_1",
        codexChatTurnId: "turn_1",
        action: "gmail.search",
        params: { query: "from:ada" },
        toolCallId: "call_1",
      },
      signal: expect.any(AbortSignal),
    });
  });
});

function request(body: Record<string, unknown>, bearer?: string) {
  return new Request("https://goat.example.com/api/internal/codex-actions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({
      codexChatSessionId: "session_1",
      codexChatTurnId: "turn_1",
      ...body,
    }),
  });
}
