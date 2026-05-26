import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentForWorkspace } from "@/lib/agents/data";
import { requireCurrentWorkspace } from "@/lib/auth";
import { GET } from "./route";

vi.mock("@/lib/agents/data", () => ({
  loadAgentForWorkspace: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireCurrentWorkspace: vi.fn(),
}));

const loadAgentForWorkspaceMock = vi.mocked(loadAgentForWorkspace);
const requireCurrentWorkspaceMock = vi.mocked(requireCurrentWorkspace);

describe("agent detail API route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireCurrentWorkspaceMock.mockResolvedValue({
      workspace: { id: "wks_123" },
    } as never);
  });

  it("decodes catch-all paths and returns the serialized agent", async () => {
    loadAgentForWorkspaceMock.mockResolvedValue({
      id: "agt_123",
      workspaceId: "wks_123",
      path: "agents/leo.agent",
      name: "Leo",
      body: "Help with issues",
      config: {
        schemaVersion: "agent.v1",
        title: "Leo",
        instructions: "Help with issues",
        model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
        tools: [],
      },
      githubCommitSha: null,
      githubSyncedAt: null,
      githubSyncStatus: "synced",
      githubSyncError: null,
      createdAt: "2026-05-24T10:00:00.000Z",
      updatedAt: "2026-05-24T10:00:00.000Z",
    });

    const response = await GET(new Request("https://app.example.com/api/agents/agents/leo.agent"), {
      params: Promise.resolve({ path: ["agents", "leo.agent"] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      agent: expect.objectContaining({
        id: "agt_123",
        path: "agents/leo.agent",
      }),
    });
    expect(loadAgentForWorkspaceMock).toHaveBeenCalledWith("wks_123", "agents/leo.agent");
  });

  it("returns 404 for a missing agent", async () => {
    loadAgentForWorkspaceMock.mockResolvedValue(null);

    const response = await GET(new Request("https://app.example.com/api/agents/missing"), {
      params: Promise.resolve({ path: ["missing"] }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Agent not found." });
  });
});
