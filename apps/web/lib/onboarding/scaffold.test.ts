import { parseAgentFile, serializeAgentFile } from "@opencompany/agent-runtime";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { agentFiles, agents } from "@opencompany/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashAgentSource } from "@/lib/agents/hash";
import { scheduleWorkspaceSyncDispatch } from "@/lib/workspace-sync/dispatch";
import { DEFAULT_SOUL_MD, DEFAULT_USER_AGENT_BODY, ensureUserOnboardingScaffold } from "./scaffold";

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/workspace-sync/dispatch", () => ({
  scheduleWorkspaceSyncDispatch: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);
const captureServerEventMock = vi.mocked(captureServerEvent);
const scheduleWorkspaceSyncDispatchMock = vi.mocked(scheduleWorkspaceSyncDispatch);

function createDbMock(selectResults: unknown[][]) {
  const pendingSelectResults = [...selectResults];
  const insertedValues: Array<{ table: unknown; value: unknown }> = [];

  const limit = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const onConflictDoUpdate = vi.fn(() => ({ query: "upsert" }));
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((value: unknown) => {
      insertedValues.push({ table, value });
      return { onConflictDoUpdate };
    }),
  }));
  const batch = vi.fn(async (queries: unknown[]) => queries);

  return {
    db: { select, insert, batch },
    insertedValues,
    batch,
    insert,
  };
}

describe("ensureUserOnboardingScaffold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a pending leo agent and requests a workspace reconcile", async () => {
    const { db, insertedValues, batch } = createDbMock([[]]);
    getDbMock.mockReturnValue(db as never);

    const result = await ensureUserOnboardingScaffold({
      userId: "usr_123",
      workspaceId: "wks_123",
    });

    const source = serializeAgentFile({
      title: "leo",
      body: DEFAULT_USER_AGENT_BODY,
      model: "minimax/minimax-m2.7-highspeed",
    });
    const parsed = parseAgentFile(source);
    const contentHash = hashAgentSource(source);
    // The starter body mounts the whole Brain so the first onboarding session can persist
    // Brain files (a session with no mount silently discards anything written under brain/).
    expect(parsed.config.brain).toEqual([{ path: "/", type: "folder" }]);
    // It also enables zero-setup, platform-credentialed research tools so leo is useful
    // immediately. (Tools needing an attached repo or workspace MCP config are left out.)
    expect(parsed.config.tools.map((tool) => tool.id)).toEqual(["exa", "x"]);
    // leo ships on throughput-optimized MiniMax M2.7 — capable and low-latency.
    expect(parsed.config.model.name).toBe("minimax/minimax-m2.7-highspeed");
    const agentInsert = insertedValues.find((entry) => entry.table === agents)?.value as {
      id: string;
      workspaceId: string;
      path: string;
      name: string;
      body: string;
      contentHash: string;
      version: number;
      githubSyncStatus: string;
      config: unknown;
    };

    expect(result).toEqual({
      created: true,
      agentId: expect.stringMatching(/^agt_[a-f0-9]{16}$/),
      path: "agents/leo/leo.agent",
    });
    expect(agentInsert).toMatchObject({
      id: result.agentId,
      workspaceId: "wks_123",
      path: "agents/leo/leo.agent",
      name: "leo",
      body: parsed.body,
      contentHash,
      version: 1,
      githubSyncStatus: "pending",
      config: parsed.config,
    });
    // leo's private operating doc is seeded alongside the agent in the same batch.
    const soulInsert = insertedValues.find((entry) => entry.table === agentFiles)?.value as {
      workspaceId: string;
      agentId: string;
      path: string;
      content: string;
      githubSyncStatus: string;
    };
    expect(soulInsert).toMatchObject({
      workspaceId: "wks_123",
      agentId: result.agentId,
      path: "agents/leo/soul.md",
      content: DEFAULT_SOUL_MD,
      githubSyncStatus: "pending",
    });
    expect(batch).toHaveBeenCalledOnce();
    expect(captureServerEventMock).toHaveBeenCalledWith("agent_created", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      agent_id: result.agentId,
    });
    expect(scheduleWorkspaceSyncDispatchMock).toHaveBeenCalledOnce();
    expect(scheduleWorkspaceSyncDispatchMock).toHaveBeenCalledWith({ workspaceId: "wks_123" });
  });

  it("skips creation when the leo agent already exists", async () => {
    const { db, insert, batch } = createDbMock([
      [{ id: "agt_existing", path: "agents/leo/leo.agent" }],
    ]);
    getDbMock.mockReturnValue(db as never);

    const result = await ensureUserOnboardingScaffold({
      userId: "usr_123",
      workspaceId: "wks_123",
    });

    expect(result).toEqual({
      created: false,
      agentId: "agt_existing",
      path: "agents/leo/leo.agent",
    });
    expect(insert).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(captureServerEventMock).not.toHaveBeenCalled();
    expect(scheduleWorkspaceSyncDispatchMock).not.toHaveBeenCalled();
  });
});
