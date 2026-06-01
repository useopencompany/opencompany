import { captureException } from "@opencompany/observability";
import { after } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  logAgentSyncJobQueued,
  prepareAgentSyncJobUpsert,
  scheduleAgentSyncDispatch,
} from "@/lib/agents/create";
import { dispatchAgentSyncRequested } from "@/lib/agents/sync-events";

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

vi.mock("next/server", () => ({
  after: vi.fn(),
}));

vi.mock("@/lib/agents/sync-events", () => ({
  dispatchAgentSyncRequested: vi.fn(),
}));

const afterMock = vi.mocked(after);
const captureExceptionMock = vi.mocked(captureException);
const dispatchAgentSyncRequestedMock = vi.mocked(dispatchAgentSyncRequested);

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

  it("prepares the sync job upsert and queue metadata from the same next run time", () => {
    const { db, conflictSets, insertedValues } = createDbMock();
    const now = new Date("2026-05-24T12:00:00.000Z");

    const result = prepareAgentSyncJobUpsert(
      db as never,
      {
        agentId: "agt_123",
        workspaceId: "wks_123",
        path: "agents/leo/agent.agent",
        desiredHash: "hash_123",
        desiredVersion: 4,
        previousPath: "agents/old/agent.agent",
        previousBlobSha: "blob_123",
      },
      { now },
    );

    expect(result.query).toEqual({ query: "agent-sync-job-upsert" });
    expect(insertedValues[0]).toMatchObject({
      agentId: "agt_123",
      workspaceId: "wks_123",
      path: "agents/leo/agent.agent",
      desiredHash: "hash_123",
      desiredVersion: 4,
      previousPath: "agents/old/agent.agent",
      previousBlobSha: "blob_123",
      status: "pending",
      attempts: 0,
      nextRunAt: new Date("2026-05-24T12:00:10.000Z"),
      lastError: null,
      updatedAt: now,
    });
    expect(conflictSets[0]).toMatchObject({
      path: "agents/leo/agent.agent",
      desiredHash: "hash_123",
      desiredVersion: 4,
      previousPath: "agents/old/agent.agent",
      previousBlobSha: "blob_123",
      status: "pending",
      attempts: 0,
      nextRunAt: new Date("2026-05-24T12:00:10.000Z"),
      lastError: null,
      updatedAt: now,
    });
    expect(result.metadata).toEqual({
      agent_id: "agt_123",
      workspace_id: "wks_123",
      path: "agents/leo/agent.agent",
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
      path: "agents/leo/agent.agent",
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
      path: "agents/leo/agent.agent",
      desired_hash: "hash_123",
      desired_version: 4,
      next_run_at: "2026-05-24T12:00:10.000Z",
      has_previous_path: false,
      has_previous_blob_sha: false,
    });
  });
});

describe("agent sync dispatch scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs Inngest event ids when dispatch succeeds", async () => {
    dispatchAgentSyncRequestedMock.mockResolvedValue({ ids: ["evt_123"] });

    scheduleAgentSyncDispatch({
      id: "agt_123",
      workspaceId: "wks_123",
      path: "agents/leo/agent.agent",
    });

    const callback = afterMock.mock.calls[0]?.[0];
    expect(callback).toBeTypeOf("function");
    await callback?.();

    expect(dispatchAgentSyncRequestedMock).toHaveBeenCalledWith({
      agentId: "agt_123",
      workspaceId: "wks_123",
    });
    expect(mocks.logger.info).toHaveBeenCalledWith("Dispatched agent GitHub sync event", {
      event: "opencompany.agent_sync_dispatch_succeeded",
      agent_id: "agt_123",
      workspace_id: "wks_123",
      path: "agents/leo/agent.agent",
      inngest_event_ids: ["evt_123"],
    });
  });

  it("captures and logs dispatch failures without changing sync status", async () => {
    const error = new Error("Inngest API Error: 401 Event key not found");
    dispatchAgentSyncRequestedMock.mockRejectedValue(error);

    scheduleAgentSyncDispatch({
      id: "agt_123",
      workspaceId: "wks_123",
      path: "agents/leo/agent.agent",
    });

    const callback = afterMock.mock.calls[0]?.[0];
    expect(callback).toBeTypeOf("function");
    await callback?.();

    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      event: "opencompany.agent_sync_dispatch_failed",
      agent_id: "agt_123",
      workspace_id: "wks_123",
      path: "agents/leo/agent.agent",
      dispatch_status_marked_failed: false,
    });
    expect(mocks.logger.error).toHaveBeenCalledWith("Failed to dispatch agent GitHub sync event", {
      event: "opencompany.agent_sync_dispatch_failed",
      agent_id: "agt_123",
      workspace_id: "wks_123",
      path: "agents/leo/agent.agent",
      dispatch_status_marked_failed: false,
      error_name: "Error",
      error_message: "Inngest API Error: 401 Event key not found",
    });
  });
});
