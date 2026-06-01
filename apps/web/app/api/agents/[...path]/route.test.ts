import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentForWorkspace } from "@/lib/agents/data";
import { currentWorkspace } from "@/lib/auth";
import { GET } from "./route";

vi.mock("@/lib/agents/data", () => ({
  loadAgentForWorkspace: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

const loadAgentForWorkspaceMock = vi.mocked(loadAgentForWorkspace);
const currentWorkspaceMock = vi.mocked(currentWorkspace);

describe("agent detail API route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      workspace: { id: "wks_123" },
    } as never);
  });

  it("decodes catch-all paths and returns the serialized agent", async () => {
    loadAgentForWorkspaceMock.mockResolvedValue({
      id: "agt_123",
      workspaceId: "wks_123",
      path: "agents/leo/leo.agent",
      name: "Leo",
      body: "Help with issues",
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Help with issues" }] }],
      },
      config: {
        schemaVersion: "agent.v1",
        title: "Leo",
        instructions: "Help with issues",
        model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
        tools: [],
        brain: [],
        integrations: { github: { repositories: [] } },
        triggers: [],
      },
      githubCommitSha: null,
      githubSyncedAt: null,
      githubSyncStatus: "synced",
      githubSyncError: null,
      createdAt: "2026-05-24T10:00:00.000Z",
      updatedAt: "2026-05-24T10:00:00.000Z",
      brainPaths: ["product/brief.md"],
      bundleFiles: [],
      githubIntegrationRepositories: [{ fullName: "opencompany/web", defaultBranch: "main" }],
      usableGitHubIntegrationRepositories: [],
      workspaceAgents: [],
      mcp: {
        mcpEnabled: false,
        linearConfigured: false,
        slackConfigured: false,
      },
    });

    const response = await GET(
      new Request("https://app.example.com/api/agents/agents/leo/leo.agent"),
      {
        params: Promise.resolve({ path: ["agents", "leo", "leo.agent"] }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      agent: expect.objectContaining({
        id: "agt_123",
        path: "agents/leo/leo.agent",
        body: "Help with issues",
        brainPaths: ["product/brief.md"],
        bundleFiles: [],
        githubIntegrationRepositories: [{ fullName: "opencompany/web", defaultBranch: "main" }],
      }),
    });
    expect(loadAgentForWorkspaceMock).toHaveBeenCalledWith("wks_123", "agents/leo/leo.agent");
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
