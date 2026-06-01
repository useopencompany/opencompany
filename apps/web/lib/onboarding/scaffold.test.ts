import { parseAgentFile, serializeAgentFile } from "@opencompany/agent-runtime";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { agentSyncJobs, agents } from "@opencompany/db/schema";
import { after } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashAgentSource } from "@/lib/agents/hash";
import { dispatchAgentSyncRequested } from "@/lib/agents/sync-events";
import { ensureUserOnboardingScaffold } from "./scaffold";

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn() })),
}));

vi.mock("next/server", () => ({
  after: vi.fn(),
}));

vi.mock("@/lib/agents/sync-events", () => ({
  dispatchAgentSyncRequested: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);
const captureServerEventMock = vi.mocked(captureServerEvent);
const afterMock = vi.mocked(after);
const dispatchAgentSyncRequestedMock = vi.mocked(dispatchAgentSyncRequested);

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
    dispatchAgentSyncRequestedMock.mockResolvedValue({ ids: ["evt_123"] });
  });

  it("creates a pending leo agent and sync job", async () => {
    const { db, insertedValues, batch } = createDbMock([[]]);
    getDbMock.mockReturnValue(db as never);

    const result = await ensureUserOnboardingScaffold({
      userId: "usr_123",
      workspaceId: "wks_123",
    });

    const source = serializeAgentFile({ title: "leo", body: "" });
    const parsed = parseAgentFile(source);
    const contentHash = hashAgentSource(source);
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
    const syncJobInsert = insertedValues.find((entry) => entry.table === agentSyncJobs)?.value as {
      agentId: string;
      workspaceId: string;
      path: string;
      desiredHash: string;
      desiredVersion: number;
      previousPath: string | null;
      previousBlobSha: string | null;
      status: string;
      attempts: number;
      nextRunAt: Date;
      lastError: string | null;
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
      body: "",
      contentHash,
      version: 1,
      githubSyncStatus: "pending",
      config: parsed.config,
    });
    expect(syncJobInsert).toMatchObject({
      agentId: result.agentId,
      workspaceId: "wks_123",
      path: "agents/leo/leo.agent",
      desiredHash: contentHash,
      desiredVersion: 1,
      previousPath: null,
      previousBlobSha: null,
      status: "pending",
      attempts: 0,
      lastError: null,
    });
    expect(syncJobInsert.nextRunAt).toBeInstanceOf(Date);
    expect(batch).toHaveBeenCalledOnce();
    expect(captureServerEventMock).toHaveBeenCalledWith("agent_created", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      agent_id: result.agentId,
    });
    expect(afterMock).toHaveBeenCalledOnce();

    const callback = afterMock.mock.calls[0]?.[0];
    expect(callback).toBeTypeOf("function");
    await callback?.();
    expect(dispatchAgentSyncRequestedMock).toHaveBeenCalledWith({
      agentId: result.agentId,
      workspaceId: "wks_123",
    });
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
    expect(afterMock).not.toHaveBeenCalled();
  });
});
