import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeActionGateway } from "@/lib/codex-actions";
import { POST } from "./route";

vi.mock("@/lib/codex-actions", () => ({
  executeActionGateway: vi.fn(),
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

describe("POST /api/internal/action-gateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "shared-secret");
    vi.mocked(executeActionGateway).mockResolvedValue({
      ok: true,
      sources: [],
    });
  });

  it("rejects requests without the shared runner bearer", async () => {
    const response = await POST(request({ operation: "list" }));

    expect(response.status).toBe(401);
    expect(executeActionGateway).not.toHaveBeenCalled();
  });

  it("accepts only bounded host identity fields", async () => {
    const response = await POST(
      request(
        {
          operation: "execute",
          sessionId: "session_1",
          turnId: "turn_1",
          action: "gmail.search",
          params: { query: "from:ada" },
          invocationId: "call_1",
          userWorkosId: "untrusted",
          workspaceId: "untrusted",
        },
        "shared-secret",
      ),
    );

    expect(response.status).toBe(200);
    expect(executeActionGateway).toHaveBeenCalledWith({
      request: {
        operation: "execute",
        sessionId: "session_1",
        turnId: "turn_1",
        action: "gmail.search",
        params: { query: "from:ada" },
        invocationId: "call_1",
      },
      signal: expect.any(AbortSignal),
    });
  });

  it("translates the previous Codex-named transport fields during deploy overlap", async () => {
    const response = await POST(
      new Request("https://app.example.com/api/internal/codex-actions", {
        method: "POST",
        headers: {
          authorization: "Bearer shared-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operation: "execute",
          codexChatSessionId: "session_1",
          codexChatTurnId: "turn_1",
          action: "gmail.search",
          params: {},
          toolCallId: "call_1",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(executeActionGateway).toHaveBeenCalledWith({
      request: {
        operation: "execute",
        sessionId: "session_1",
        turnId: "turn_1",
        action: "gmail.search",
        params: {},
        invocationId: "call_1",
      },
      signal: expect.any(AbortSignal),
    });
  });
});

function request(body: Record<string, unknown>, bearer?: string) {
  return new Request("https://app.example.com/api/internal/action-gateway", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({
      sessionId: "session_1",
      turnId: "turn_1",
      ...body,
    }),
  });
}
