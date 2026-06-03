import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentSessionStreamCredentialForWorkspace } from "@/lib/agent-sessions/data";
import { currentWorkspace } from "@/lib/auth";
import { POST } from "./route";

vi.mock("@/lib/agent-sessions/data", () => ({
  loadAgentSessionStreamCredentialForWorkspace: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

const loadAgentSessionStreamCredentialForWorkspaceMock = vi.mocked(
  loadAgentSessionStreamCredentialForWorkspace,
);
const currentWorkspaceMock = vi.mocked(currentWorkspace);

describe("session stream token API route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
  });

  it("returns a stream credential for the current workspace user", async () => {
    loadAgentSessionStreamCredentialForWorkspaceMock.mockResolvedValue({
      runnerUrl: "https://runner.example.com",
      streamToken: "token_123",
      streamTokenExpiresAt: 1_780_000_000_000,
    });

    const response = await POST(
      new Request("https://app.example.com/api/sessions/ses_123/stream-token", {
        method: "POST",
      }),
      {
        params: Promise.resolve({ id: "ses_123" }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      runnerUrl: "https://runner.example.com",
      streamToken: "token_123",
      streamTokenExpiresAt: 1_780_000_000_000,
    });
    expect(loadAgentSessionStreamCredentialForWorkspaceMock).toHaveBeenCalledWith(
      "ses_123",
      "usr_123",
      "wks_123",
    );
  });

  it("returns 404 for missing sessions", async () => {
    loadAgentSessionStreamCredentialForWorkspaceMock.mockResolvedValue(null);

    const response = await POST(
      new Request("https://app.example.com/api/sessions/missing/stream-token", {
        method: "POST",
      }),
      {
        params: Promise.resolve({ id: "missing" }),
      },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Session not found." });
  });

  it("propagates auth redirects instead of returning stream credentials", async () => {
    currentWorkspaceMock.mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(
      POST(
        new Request("https://app.example.com/api/sessions/ses_123/stream-token", {
          method: "POST",
        }),
        {
          params: Promise.resolve({ id: "ses_123" }),
        },
      ),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(loadAgentSessionStreamCredentialForWorkspaceMock).not.toHaveBeenCalled();
  });
});
