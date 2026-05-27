import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentsForWorkspace } from "@/lib/agents/data";
import { currentWorkspace } from "@/lib/auth";
import { GET } from "./route";

vi.mock("@/lib/agents/data", () => ({
  loadAgentsForWorkspace: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

const loadAgentsForWorkspaceMock = vi.mocked(loadAgentsForWorkspace);
const currentWorkspaceMock = vi.mocked(currentWorkspace);

describe("agents API route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      workspace: { id: "wks_123" },
    } as never);
  });

  it("returns serialized agents for the current workspace", async () => {
    loadAgentsForWorkspaceMock.mockResolvedValue([
      {
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
        githubSyncStatus: "pending",
        githubSyncError: null,
        createdAt: "2026-05-24T10:00:00.000Z",
        updatedAt: "2026-05-24T10:00:00.000Z",
      },
    ]);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      agents: [
        expect.objectContaining({
          id: "agt_123",
          path: "agents/leo.agent",
          githubSyncStatus: "pending",
        }),
      ],
    });
    expect(loadAgentsForWorkspaceMock).toHaveBeenCalledWith("wks_123");
  });
});
