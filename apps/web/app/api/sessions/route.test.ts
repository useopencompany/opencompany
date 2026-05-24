import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSidebarSessionsForWorkspace } from "@/lib/agent-sessions/data";
import { requireCurrentWorkspace } from "@/lib/auth";
import { GET } from "./route";

vi.mock("@/lib/agent-sessions/data", () => ({
  loadSidebarSessionsForWorkspace: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireCurrentWorkspace: vi.fn(),
}));

const loadSidebarSessionsForWorkspaceMock = vi.mocked(loadSidebarSessionsForWorkspace);
const requireCurrentWorkspaceMock = vi.mocked(requireCurrentWorkspace);

describe("sessions API route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireCurrentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
  });

  it("returns sidebar sessions for the current workspace user", async () => {
    loadSidebarSessionsForWorkspaceMock.mockResolvedValue([
      {
        id: "ses_123",
        title: "Fix issue",
        status: "running",
        modelName: "openai/gpt-5.4-mini",
        lastError: null,
        createdAt: "2026-05-24T10:00:00.000Z",
        updatedAt: "2026-05-24T10:01:00.000Z",
      },
    ]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      sessions: [
        expect.objectContaining({
          id: "ses_123",
          status: "running",
        }),
      ],
    });
    expect(loadSidebarSessionsForWorkspaceMock).toHaveBeenCalledWith("usr_123", "wks_123");
  });

  it("propagates auth redirects instead of returning session data", async () => {
    requireCurrentWorkspaceMock.mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(GET()).rejects.toThrow("NEXT_REDIRECT");
    expect(loadSidebarSessionsForWorkspaceMock).not.toHaveBeenCalled();
  });
});
