import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeGoatCodexBrainCaptureGateway } from "@/lib/codex-brain-capture";
import { POST } from "./route";

vi.mock("@/lib/codex-brain-capture", () => ({
  executeGoatCodexBrainCaptureGateway: vi.fn(),
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

describe("POST /api/internal/codex-brain-capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "shared-secret");
    vi.mocked(executeGoatCodexBrainCaptureGateway).mockResolvedValue({
      ok: true,
      status: "captured",
      draftId: "launch-decision",
      path: "inbox/launch-decision.md",
      title: "Launch decision",
    });
  });

  it("rejects requests without the shared runner bearer", async () => {
    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(executeGoatCodexBrainCaptureGateway).not.toHaveBeenCalled();
  });

  it("accepts only bounded host identity and capture fields", async () => {
    const response = await POST(
      request("shared-secret", {
        userWorkosId: "untrusted",
        brainRef: "untrusted",
      }),
    );

    expect(response.status).toBe(200);
    expect(executeGoatCodexBrainCaptureGateway).toHaveBeenCalledWith({
      request: {
        codexChatSessionId: "session_1",
        codexChatTurnId: "turn_1",
        content: "Remember this.",
        title: "Decision",
      },
    });
  });

  it("rejects an empty capture before calling the gateway", async () => {
    const response = await POST(
      request("shared-secret", {
        content: " ",
        title: undefined,
      }),
    );

    expect(response.status).toBe(400);
    expect(executeGoatCodexBrainCaptureGateway).not.toHaveBeenCalled();
  });

  it("rejects oversized content instead of silently falling back to a source pointer", async () => {
    const response = await POST(
      request("shared-secret", {
        content: "x".repeat(64_001),
        sourceRef: "linear:issue:ENG-1",
        title: undefined,
      }),
    );

    expect(response.status).toBe(400);
    expect(executeGoatCodexBrainCaptureGateway).not.toHaveBeenCalled();
  });
});

function request(bearer?: string, overrides: Record<string, unknown> = {}) {
  return new Request("https://goat.example.com/api/internal/codex-brain-capture", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({
      codexChatSessionId: "session_1",
      codexChatTurnId: "turn_1",
      content: "Remember this.",
      title: "Decision",
      ...overrides,
    }),
  });
}
