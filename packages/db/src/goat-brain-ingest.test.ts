import { describe, expect, it } from "vitest";
import { upsertGoatBrainSourceItemAndEnqueue } from "./goat-brain-ingest";
import { goatBrainIngestJobs, goatBrainSourceItems, goatBrains } from "./goat-schema";

describe("upsertGoatBrainSourceItemAndEnqueue", () => {
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
    const db = goatBrainIngestDbMock({ sourceItem, jobs: [existingJob] });

    const result = await upsertGoatBrainSourceItemAndEnqueue({
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
});

function goatBrainIngestDbMock(input: {
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
            if (table !== goatBrainSourceItems) throw new Error("Unexpected source insert table.");
            return [input.sourceItem];
          },
        }),
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== goatBrainIngestJobs) throw new Error("Unexpected job insert table.");
            return [];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if (table === goatBrainIngestJobs) {
            for (const job of input.jobs) {
              if (job.status !== "queued") continue;
              Object.assign(job, values);
            }
            return;
          }
          if (table === goatBrainSourceItems) {
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
          if (table === goatBrains) {
            return [{ id: "goat_brain_123", workspaceId: "goat_workspace_123" }];
          }
          if (table === goatBrainIngestJobs) return input.jobs;
          throw new Error("Unexpected select table.");
        },
      }),
    }),
  };
  return db;
}
