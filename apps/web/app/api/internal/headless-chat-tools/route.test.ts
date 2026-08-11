import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeHeadlessChatHostToolGateway } from "@/lib/headless-chat-host-tools";
import { POST } from "./route";

vi.mock("@/lib/headless-chat-host-tools", () => ({
  executeHeadlessChatHostToolGateway: vi.fn(),
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

describe("POST /api/internal/headless-chat-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "shared-secret");
    vi.mocked(executeHeadlessChatHostToolGateway).mockResolvedValue({
      ok: true,
      result: { browserToolsEnabled: true },
    });
  });

  it("rejects requests without the shared runner bearer", async () => {
    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(executeHeadlessChatHostToolGateway).not.toHaveBeenCalled();
  });

  it("accepts bounded turn identity while the host service derives authorization", async () => {
    const response = await POST(
      request("shared-secret", {
        userWorkosId: "untrusted",
        workspaceId: "untrusted",
      }),
    );

    expect(response.status).toBe(200);
    expect(executeHeadlessChatHostToolGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          operation: "bootstrap",
          sessionId: "session_1",
          turnId: "turn_1",
          input: {
            mentionedSkillIds: ["sales"],
            userWorkosId: "untrusted",
            workspaceId: "untrusted",
          },
        },
      }),
    );
  });

  it("rejects unknown operations before the host service", async () => {
    const response = await POST(request("shared-secret", {}, { operation: "production_delete" }));

    expect(response.status).toBe(400);
    expect(executeHeadlessChatHostToolGateway).not.toHaveBeenCalled();
  });
});

function request(
  bearer?: string,
  extraInput: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  return new Request("https://goat.example.com/api/internal/headless-chat-tools", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({
      operation: "bootstrap",
      sessionId: "session_1",
      turnId: "turn_1",
      input: { mentionedSkillIds: ["sales"], ...extraInput },
      ...overrides,
    }),
  });
}
