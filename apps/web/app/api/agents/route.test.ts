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
        path: "agents/leo/leo.agent",
        name: "Leo",
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
        githubSyncStatus: "pending",
        githubSyncError: null,
        createdAt: "2026-05-24T10:00:00.000Z",
        updatedAt: "2026-05-24T10:00:00.000Z",
      },
    ]);

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      agents: [
        expect.objectContaining({
          id: "agt_123",
          path: "agents/leo/leo.agent",
          githubSyncStatus: "pending",
        }),
      ],
    });
    expect(loadAgentsForWorkspaceMock).toHaveBeenCalledWith("wks_123");
  });

  it("does not include detail-only editor fields in list payloads", async () => {
    loadAgentsForWorkspaceMock.mockResolvedValue([
      {
        id: "agt_123",
        workspaceId: "wks_123",
        path: "agents/leo/leo.agent",
        name: "Leo",
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
        githubSyncStatus: "pending",
        githubSyncError: null,
        createdAt: "2026-05-24T10:00:00.000Z",
        updatedAt: "2026-05-24T10:00:00.000Z",
      },
    ]);

    const response = await GET();
    const body = (await response.json()) as { agents: Array<Record<string, unknown>> };
    const [agent] = body.agents;

    expect(agent).not.toHaveProperty("body");
    expect(agent).not.toHaveProperty("content");
    expect(agent).not.toHaveProperty("brainPaths");
    expect(agent).not.toHaveProperty("githubIntegrationRepositories");
  });
});
