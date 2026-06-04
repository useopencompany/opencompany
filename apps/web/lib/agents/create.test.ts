import { beforeEach, describe, expect, it, vi } from "vitest";
import { logAgentSyncJobQueued, prepareAgentSyncJobUpsert } from "@/lib/agents/create";

const mocks = vi.hoisted(() => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
  createLogger: vi.fn(() => mocks.logger),
}));

function createDbMock() {
  const insertedValues: Record<string, unknown>[] = [];
  const conflictSets: Record<string, unknown>[] = [];
  const onConflictDoUpdate = vi.fn((input: { set: Record<string, unknown> }) => {
    conflictSets.push(input.set);
    return { query: "agent-sync-job-upsert" };
  });
  const insert = vi.fn(() => ({
    values: vi.fn((value: Record<string, unknown>) => {
      insertedValues.push(value);
      return { onConflictDoUpdate };
    }),
  }));

  return {
    db: { insert },
    conflictSets,
    insertedValues,
  };
}

describe("agent sync job logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues the agent into the workspace projection outbox with deterministic timing", () => {
    const { db, conflictSets, insertedValues } = createDbMock();
    const now = new Date("2026-05-24T12:00:00.000Z");

    const result = prepareAgentSyncJobUpsert(
      db as never,
      {
        agentId: "agt_123",
        workspaceId: "wks_123",
        path: "agents/leo/leo.agent",
        desiredHash: "hash_123",
        desiredVersion: 4,
        previousPath: "agents/old/old.agent",
        previousBlobSha: "blob_123",
      },
      { now },
    );

    expect(result.query).toEqual({ query: "agent-sync-job-upsert" });
    expect(insertedValues[0]).toMatchObject({
      workspaceId: "wks_123",
      repoPath: "agents/leo/leo.agent",
      sourceKind: "agent",
      sourceRef: "agt_123",
      operation: "upsert",
      desiredHash: "hash_123",
      previousPath: "agents/old/old.agent",
      previousBlobSha: "blob_123",
      nextRunAt: new Date("2026-05-24T12:00:10.000Z"),
      updatedAt: now,
    });
    expect(conflictSets[0]).toMatchObject({
      sourceKind: "agent",
      sourceRef: "agt_123",
      operation: "upsert",
      desiredHash: "hash_123",
      previousPath: "agents/old/old.agent",
      previousBlobSha: "blob_123",
      status: "pending",
      nextRunAt: new Date("2026-05-24T12:00:10.000Z"),
      lastError: null,
      updatedAt: now,
    });
    expect(result.metadata).toEqual({
      agent_id: "agt_123",
      workspace_id: "wks_123",
      path: "agents/leo/leo.agent",
      desired_hash: "hash_123",
      desired_version: 4,
      next_run_at: "2026-05-24T12:00:10.000Z",
      has_previous_path: true,
      has_previous_blob_sha: true,
    });
  });

  it("logs queued sync jobs with searchable top-level fields", () => {
    logAgentSyncJobQueued({
      agent_id: "agt_123",
      workspace_id: "wks_123",
      path: "agents/leo/leo.agent",
      desired_hash: "hash_123",
      desired_version: 4,
      next_run_at: "2026-05-24T12:00:10.000Z",
      has_previous_path: false,
      has_previous_blob_sha: false,
    });

    expect(mocks.logger.info).toHaveBeenCalledWith("Queued agent GitHub sync job", {
      event: "opencompany.agent_sync_job_queued",
      agent_id: "agt_123",
      workspace_id: "wks_123",
      path: "agents/leo/leo.agent",
      desired_hash: "hash_123",
      desired_version: 4,
      next_run_at: "2026-05-24T12:00:10.000Z",
      has_previous_path: false,
      has_previous_blob_sha: false,
    });
  });
});
