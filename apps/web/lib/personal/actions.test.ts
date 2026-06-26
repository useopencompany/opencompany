import type { AgentConfig, TiptapDoc } from "@opencompany/agent-runtime/types";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadAgentReferencesForWorkspace,
  loadGitHubIntegrationRepositoriesForWorkspace,
} from "@/lib/agents/data";
import { currentWorkspace } from "@/lib/auth";
import { listWorkspaceSkillSnapshots } from "@/lib/skills/snapshots";
import { updatePersonalAgentBehavior } from "./actions";

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

vi.mock("@/lib/agents/data", () => ({
  loadAgentReferencesForWorkspace: vi.fn(),
  loadGitHubIntegrationRepositoriesForWorkspace: vi.fn(),
}));

vi.mock("@/lib/skills/snapshots", () => ({
  listWorkspaceSkillSnapshots: vi.fn(),
  toExternalSkillReference: vi.fn((snapshot) => snapshot),
}));

const getDbMock = vi.mocked(getDb);
const currentWorkspaceMock = vi.mocked(currentWorkspace);
const captureServerEventMock = vi.mocked(captureServerEvent);
const loadAgentReferencesForWorkspaceMock = vi.mocked(loadAgentReferencesForWorkspace);
const loadGitHubIntegrationRepositoriesForWorkspaceMock = vi.mocked(
  loadGitHubIntegrationRepositoriesForWorkspace,
);
const listWorkspaceSkillSnapshotsMock = vi.mocked(listWorkspaceSkillSnapshots);

const emptyContent: TiptapDoc = { type: "doc", content: [] };

describe("updatePersonalAgentBehavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
    loadGitHubIntegrationRepositoriesForWorkspaceMock.mockResolvedValue([]);
    listWorkspaceSkillSnapshotsMock.mockResolvedValue([]);
  });

  it("binds mentioned company agents into the personal agent config", async () => {
    const { db, updates } = dbWithPersonalAgent(personalAgent());
    getDbMock.mockReturnValue(db as never);
    loadAgentReferencesForWorkspaceMock.mockResolvedValue([
      { path: "agents/research/research.agent", name: "Research" },
    ]);

    const result = await updatePersonalAgentBehavior("agt_personal", {
      body: "Ask @agent/research for account notes.",
      content: emptyContent,
    });

    expect(result).toMatchObject({
      ok: true,
      config: {
        agents: [{ path: "agents/research/research.agent", name: "Research" }],
      },
    });
    expect(updates[0]?.config.agents).toEqual([
      { path: "agents/research/research.agent", name: "Research" },
    ]);
    expect(loadAgentReferencesForWorkspaceMock).toHaveBeenCalledWith("wks_123");
    expect(captureServerEventMock).toHaveBeenCalledWith("agent_saved", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      agent_id: "agt_personal",
      changed_fields: ["body"],
    });
  });

  it("removes delegation when the agent mention is removed from the body", async () => {
    const { db, updates } = dbWithPersonalAgent(
      personalAgent({
        agents: [{ path: "agents/research/research.agent", name: "Research" }],
      }),
    );
    getDbMock.mockReturnValue(db as never);
    loadAgentReferencesForWorkspaceMock.mockResolvedValue([
      { path: "agents/research/research.agent", name: "Research" },
    ]);

    const result = await updatePersonalAgentBehavior("agt_personal", {
      body: "Work directly without delegation.",
      content: emptyContent,
    });

    expect(result).toMatchObject({ ok: true, config: { agents: [] } });
    expect(updates[0]?.config.agents).toEqual([]);
  });

  it("keeps unknown agent mentions as body text without granting delegation", async () => {
    const { db, updates } = dbWithPersonalAgent(personalAgent());
    getDbMock.mockReturnValue(db as never);
    loadAgentReferencesForWorkspaceMock.mockResolvedValue([]);

    const result = await updatePersonalAgentBehavior("agt_personal", {
      body: "Ask @agent/missing for help.",
      content: emptyContent,
    });

    expect(result).toMatchObject({ ok: true, config: { agents: [] } });
    expect(updates[0]).toMatchObject({
      body: "Ask @agent/missing for help.",
      config: { agents: [] },
    });
  });
});

function personalAgent(configPatch: Partial<AgentConfig> = {}) {
  const config: AgentConfig = {
    schemaVersion: "agent.v1",
    title: "Leo",
    instructions: "Personal instructions",
    engine: "opencompany",
    model: { provider: "vercel-ai-gateway", name: "moonshotai/kimi-k2.6" },
    tools: [],
    brain: [],
    agents: [],
    integrations: { github: { repositories: [] } },
    triggers: [],
    ...configPatch,
  };

  return {
    id: "agt_personal",
    name: "Leo",
    config,
    version: 1,
  };
}

function dbWithPersonalAgent(agent: ReturnType<typeof personalAgent>) {
  const updates: Array<{ body: string; config: AgentConfig }> = [];
  const limit = vi.fn(async () => [agent]);
  const orderBy = vi.fn(async () => []);
  const whereSelect = vi.fn(() => ({ limit, orderBy }));
  const from = vi.fn(() => ({ where: whereSelect }));
  const select = vi.fn(() => ({ from }));
  const whereUpdate = vi.fn();
  const set = vi.fn((values: { body: string; config: AgentConfig }) => {
    updates.push(values);
    return { where: whereUpdate };
  });
  const update = vi.fn(() => ({ set }));
  return { db: { select, update }, updates };
}
