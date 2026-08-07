import { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { describe, expect, it, vi } from "vitest";
import { brainIngestJobs, brainSourceItems, brains } from "./schema";

const { getDbMock, reserveWorkspaceIngestionMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  reserveWorkspaceIngestionMock: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
    reservation: { workspaceId },
    pendingUnits: 0,
    paused: false,
    created: false,
  })),
}));
vi.mock("./client", () => ({ getDb: getDbMock }));
vi.mock("./billing", () => ({
  reserveWorkspaceIngestion: reserveWorkspaceIngestionMock,
}));

const { upsertBrainSourceItemAndEnqueue } = await import("./brain-ingest");

describe("upsertBrainSourceItemAndEnqueue", () => {
  it("persists discovery candidates without enqueueing an ingest job", async () => {
    let jobInsertAttempted = false;
    const db = {
      insert: (table: unknown) => {
        if (table === brainIngestJobs) jobInsertAttempted = true;
        return {
          values: () => ({
            onConflictDoUpdate: () => ({
              returning: async () => [{ id: "gbsrc_discovery" }],
            }),
          }),
        };
      },
    };

    const result = await upsertBrainSourceItemAndEnqueue({
      userWorkosId: "user_123",
      sourceConnectionId: "gbimp_123",
      item: {
        sourceProvider: "goat-import",
        sourceType: "run",
        externalId: "gbimp_123:research",
        sourceRef: "goat-import:gbimp_123:research",
        title: "Company bootstrap",
        occurredAt: "2026-07-13T10:00:00.000Z",
        capturedAt: "2026-07-13T10:00:00.000Z",
        contentHash: "hash_123",
        contentHashInput: {},
        content: {},
      },
      rawPayload: {},
      kind: "brain_agent_ingest",
      brainRefs: [],
      db,
    });

    expect(jobInsertAttempted).toBe(false);
    expect(result).toMatchObject({
      sourceItemId: "gbsrc_discovery",
      jobId: null,
      jobIds: [],
      enqueued: false,
    });
  });

  it("propagates the import run id to newly enqueued jobs", async () => {
    let insertedJobValues: Array<Record<string, unknown>> = [];
    const db = {
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => ({
          onConflictDoUpdate: () => ({
            returning: async () => {
              if (table !== brainSourceItems) throw new Error("Unexpected source insert table.");
              return [{ id: "gbsrc_import" }];
            },
          }),
          onConflictDoNothing: () => ({
            returning: async () => {
              if (table !== brainIngestJobs) throw new Error("Unexpected job insert table.");
              insertedJobValues = Array.isArray(values) ? values : [values];
              return [
                {
                  id: "gbjob_import",
                  brainRef: "goat_brain_123",
                  status: "queued",
                  completedAt: null,
                  lastError: null,
                },
              ];
            },
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: () => ({
          where: async () => {
            if (table !== brainSourceItems) throw new Error("Unexpected update table.");
          },
        }),
      }),
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table !== brains) throw new Error("Unexpected select table.");
            return [{ id: "goat_brain_123", workspaceId: "goat_workspace_123" }];
          },
        }),
      }),
    };

    const result = await upsertBrainSourceItemAndEnqueue({
      userWorkosId: "user_123",
      sourceConnectionId: "gbimp_123",
      importRunId: "gbimp_123",
      brainRef: "goat_brain_123",
      item: {
        sourceProvider: "goat-import",
        sourceType: "run",
        externalId: "gbimp_123:research",
        sourceRef: "goat-import:gbimp_123:research",
        title: "Company bootstrap",
        occurredAt: "2026-07-13T10:00:00.000Z",
        capturedAt: "2026-07-13T10:00:00.000Z",
        contentHash: "hash_123",
        contentHashInput: {},
        content: {},
      },
      rawPayload: {},
      kind: "brain_agent_ingest",
      db,
    });

    expect(insertedJobValues).toHaveLength(1);
    expect(insertedJobValues[0]).toMatchObject({
      importRunId: "gbimp_123",
      brainRef: "goat_brain_123",
      sourceItemId: "gbsrc_import",
    });
    expect(result).toMatchObject({
      jobId: "gbjob_import",
      enqueued: true,
      skipped: false,
    });
  });

  it("bills only the union of newly claimed events in each workspace", async () => {
    reserveWorkspaceIngestionMock.mockClear();
    const brainRows = [
      { id: "brain_a", workspaceId: "workspace_one" },
      { id: "brain_b", workspaceId: "workspace_one" },
      { id: "brain_c", workspaceId: "workspace_two" },
    ];
    const db = {
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => ({
          onConflictDoUpdate: () => ({
            returning: async () => {
              if (table !== brainSourceItems) throw new Error("Unexpected source insert table.");
              return [{ id: "gbsrc_claimed_window" }];
            },
          }),
          onConflictDoNothing: () => ({
            returning: async () => {
              if (table !== brainIngestJobs) throw new Error("Unexpected job insert table.");
              const rows = Array.isArray(values) ? values : [values];
              return rows.map((row, index) => ({
                id: `job_${index}`,
                brainRef: row.brainRef,
                status: "queued",
                completedAt: null,
                lastError: null,
              }));
            },
          }),
        }),
      }),
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table !== brains) throw new Error("Unexpected select table.");
            return brainRows;
          },
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };

    await upsertBrainSourceItemAndEnqueue({
      userWorkosId: "user_123",
      sourceConnectionId: "slack_connection_123",
      integrationId: "integration_123",
      item: {
        sourceProvider: "slack",
        sourceType: "conversation",
        externalId: "window_123",
        sourceRef: "slack:window_123",
        title: "Slack window",
        occurredAt: "2026-07-15T10:00:00.000Z",
        capturedAt: "2026-07-15T10:01:00.000Z",
        contentHash: "hash_claimed_window",
        contentHashInput: {},
        content: {},
      },
      rawPayload: {},
      brainRefs: brainRows.map((brain) => brain.id),
      rawEventCount: 2,
      rawEventKeysByBrainRef: new Map([
        ["brain_a", ["message_1"]],
        ["brain_b", ["message_1", "message_2"]],
        ["brain_c", ["message_2"]],
      ]),
      db,
    });

    expect(reserveWorkspaceIngestionMock).toHaveBeenCalledTimes(2);
    expect(reserveWorkspaceIngestionMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace_one", rawEventCount: 2 }),
    );
    expect(reserveWorkspaceIngestionMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace_two", rawEventCount: 1 }),
    );
  });

  it("transitions duplicate queued jobs to skipped on repeated skip delivery", async () => {
    const now = new Date("2026-07-10T10:15:00.000Z");
    const sourceItem = { id: "gbsrc_existing" };
    const existingJob = {
      id: "gbjob_existing",
      brainRef: "goat_brain_123",
      status: "queued",
      completedAt: null,
      lastError: null,
      result: {},
    };
    const db = brainIngestDbMock({ sourceItem, jobs: [existingJob] });

    const result = await upsertBrainSourceItemAndEnqueue({
      userWorkosId: "user_123",
      sourceConnectionId: "glinconn_123",
      integrationId: "gint_123",
      item: {
        sourceProvider: "linear",
        sourceType: "issue",
        externalId: "issue_123",
        sourceRef: "linear:issue:G-51",
        title: "G-51 add github as source",
        occurredAt: "2026-07-10T10:00:00.000Z",
        capturedAt: "2026-07-10T10:01:00.000Z",
        contentHash: "hash_123",
        contentHashInput: {},
        content: {},
      },
      rawPayload: { eventIds: ["glin_123"] },
      kind: "brain_agent_ingest",
      brainRefs: ["goat_brain_123"],
      skipReason: "routine_linear_status_change",
      now,
      db,
    });

    expect(result).toEqual({
      sourceItemId: "gbsrc_existing",
      jobId: "gbjob_existing",
      jobIds: ["gbjob_existing"],
      enqueued: false,
      skipped: true,
    });
    expect(existingJob).toMatchObject({
      status: "skipped",
      completedAt: now,
      result: {
        skipped: true,
        reason: "routine_linear_status_change",
        summary: "routine_linear_status_change",
      },
    });
    expect(db.sourceItemUpdate).toMatchObject({
      lastIngestJobId: "gbjob_existing",
      lastIngestStatus: "skipped",
      lastIngestedAt: now,
      lastIngestError: "routine_linear_status_change",
    });
  });

  it("runs sequentially instead of opening a transaction on the neon-http web client", async () => {
    // Regression: the web app's getDb() is neon-http, which throws on
    // db.transaction(). Callers that omit `db` (e.g. chat save_to_brain capture)
    // must fall back to sequential mutations rather than crashing the request.
    const now = new Date("2026-07-10T10:15:00.000Z");
    const sourceItem = { id: "gbsrc_existing" };
    const existingJob = {
      id: "gbjob_existing",
      brainRef: "goat_brain_123",
      status: "queued",
      completedAt: null,
      lastError: null,
      result: {},
    };
    const db = brainIngestDbMock({ sourceItem, jobs: [existingJob] });
    const transaction = vi.fn(() => {
      throw new Error("No transactions support in neon-http driver");
    });
    Object.assign(db, { transaction });
    // Make `db instanceof NeonHttpDatabase` true so the guard treats it as the
    // web client while keeping the mocked query chain.
    Object.setPrototypeOf(db, NeonHttpDatabase.prototype);
    getDbMock.mockReturnValue(db);

    const result = await upsertBrainSourceItemAndEnqueue({
      userWorkosId: "user_123",
      sourceConnectionId: "glinconn_123",
      integrationId: "gint_123",
      item: {
        sourceProvider: "linear",
        sourceType: "issue",
        externalId: "issue_123",
        sourceRef: "linear:issue:G-51",
        title: "G-51 add github as source",
        occurredAt: "2026-07-10T10:00:00.000Z",
        capturedAt: "2026-07-10T10:01:00.000Z",
        contentHash: "hash_123",
        contentHashInput: {},
        content: {},
      },
      rawPayload: { eventIds: ["glin_123"] },
      kind: "brain_agent_ingest",
      brainRefs: ["goat_brain_123"],
      skipReason: "routine_linear_status_change",
      now,
    });

    expect(transaction).not.toHaveBeenCalled();
    expect(result).toEqual({
      sourceItemId: "gbsrc_existing",
      jobId: "gbjob_existing",
      jobIds: ["gbjob_existing"],
      enqueued: false,
      skipped: true,
    });
  });
});

function brainIngestDbMock(input: {
  sourceItem: { id: string };
  jobs: Array<{
    id: string;
    brainRef: string | null;
    status: string;
    completedAt: Date | null;
    lastError: string | null;
    result: Record<string, unknown>;
  }>;
}) {
  const db = {
    sourceItemUpdate: null as Record<string, unknown> | null,
    insert: (table: unknown) => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            if (table !== brainSourceItems) throw new Error("Unexpected source insert table.");
            return [input.sourceItem];
          },
        }),
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== brainIngestJobs) throw new Error("Unexpected job insert table.");
            return [];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if (table === brainIngestJobs) {
            for (const job of input.jobs) {
              if (job.status !== "queued") continue;
              Object.assign(job, values);
            }
            return;
          }
          if (table === brainSourceItems) {
            db.sourceItemUpdate = values;
            return;
          }
          throw new Error("Unexpected update table.");
        },
      }),
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === brains) {
            return [{ id: "goat_brain_123", workspaceId: "goat_workspace_123" }];
          }
          if (table === brainIngestJobs) return input.jobs;
          throw new Error("Unexpected select table.");
        },
      }),
    }),
  };
  return db;
}
