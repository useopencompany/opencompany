import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  wikiIngestJobs,
  wikiSourceEventClaims,
  wikiSourceItems,
  wikiSources,
} from "./product-schema";

const { getDbMock, reserveWorkspaceIngestionMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  reserveWorkspaceIngestionMock: vi.fn(
    async ({ workspaceId }: { workspaceId: string; sourceItemId: string }) => ({
      reservation: { workspaceId, status: "consumed" },
      pendingUnits: 0,
      paused: false,
      created: true,
    }),
  ),
}));
vi.mock("./client", () => ({ getDb: getDbMock }));
vi.mock("./billing", () => ({
  reserveWorkspaceIngestion: reserveWorkspaceIngestionMock,
}));

const {
  claimNextWikiIngestJob,
  completeWikiIngestJob,
  failWikiIngestJobWithBackoff,
  heartbeatWikiIngestJob,
  listWikiIngestActivityRows,
  releaseWikiIngestJob,
  skipWikiIngestJob,
  upsertWikiSourceItemAndEnqueue,
  wikiIngestRetryAt,
} = await import("./wiki-ingest");

const dialect = new PgDialect();

beforeEach(() => {
  getDbMock.mockReset();
  reserveWorkspaceIngestionMock.mockClear();
});

describe("wiki ingestion schema", () => {
  it("deduplicates normalized windows and their single ingest job on the proven keys", () => {
    expect(
      indexColumns(wikiSourceItems, "opencompany_wiki_source_items_connection_external_hash_idx"),
    ).toEqual([
      "workspace_id",
      "source_provider",
      "source_connection_id",
      "source_type",
      "external_id",
      "content_hash",
    ]);
    expect(indexColumns(wikiIngestJobs, "opencompany_wiki_ingest_jobs_item_hash_idx")).toEqual([
      "source_item_id",
      "content_hash",
    ]);
    expect(
      indexColumns(wikiIngestJobs, "opencompany_wiki_ingest_jobs_workspace_running_idx"),
    ).toEqual(["workspace_id"]);
  });

  it("keeps public source configuration to launch providers and permits internal imports", () => {
    const tables = [
      [wikiSources, "opencompany_wiki_sources_provider_check"],
      [wikiSourceItems, "opencompany_wiki_source_items_source_provider_check"],
      [wikiIngestJobs, "opencompany_wiki_ingest_jobs_source_provider_check"],
      [wikiSourceEventClaims, "opencompany_wiki_source_event_claims_source_provider_check"],
    ] as const;
    for (const [table, constraintName] of tables) {
      const constraint = getTableConfig(table).checks.find(
        (check) => check.name === constraintName,
      );
      expect(constraint, `Missing ${constraintName}`).toBeDefined();
      const query = dialect.sqlToQuery(constraint!.value).sql;
      expect(query).not.toContain("google_drive");
      if (table === wikiSourceItems || table === wikiIngestJobs) {
        expect(query).toContain(
          "IN ('gmail', 'slack', 'jamie', 'granola', 'linear', 'github', 'opencompany-import')",
        );
      } else {
        expect(query).toContain("IN ('gmail', 'slack', 'jamie', 'granola', 'linear', 'github')");
        expect(query).not.toContain("'opencompany-import'");
      }
    }
  });
});

describe("upsertWikiSourceItemAndEnqueue", () => {
  it("upserts the deduped item, inserts one job, and reserves workspace admission", async () => {
    let jobValues: Record<string, unknown> | undefined;
    let jobConflict: { target?: unknown[] } | undefined;
    const db = {
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          if (table === wikiSourceItems) {
            return {
              onConflictDoUpdate: () => ({
                returning: async () => [{ id: "gwsrc_1" }],
              }),
            };
          }
          if (table === wikiIngestJobs) {
            jobValues = values;
            return {
              onConflictDoNothing: (config: { target?: unknown[] }) => {
                jobConflict = config;
                return {
                  returning: async () => [
                    {
                      id: "gwjob_1",
                      status: "queued",
                      completedAt: null,
                      lastError: null,
                      skipReason: null,
                    },
                  ],
                };
              },
            };
          }
          throw new Error("Unexpected insert table.");
        },
      }),
      update: (table: unknown) => ({
        set: () => ({
          where: async () => {
            if (table !== wikiSourceItems) throw new Error("Unexpected update table.");
          },
        }),
      }),
    };

    await expect(
      upsertWikiSourceItemAndEnqueue({
        workspaceId: "workspace_1",
        sourceConnectionId: "slack_team_1",
        integrationId: "integration_1",
        item: wikiItem(),
        rawPayload: { eventIds: ["event_1", "event_2"] },
        rawEventCount: 2,
        now: new Date("2026-08-24T09:00:00.000Z"),
        db,
      }),
    ).resolves.toEqual({
      sourceItemId: "gwsrc_1",
      jobId: "gwjob_1",
      enqueued: true,
      skipped: false,
    });

    expect(jobValues).toMatchObject({
      workspaceId: "workspace_1",
      sourceItemId: "gwsrc_1",
      status: "queued",
    });
    expect(jobValues).not.toHaveProperty("sourceKind");
    expect(jobConflict?.target).toEqual([wikiIngestJobs.sourceItemId, wikiIngestJobs.contentHash]);
    expect(reserveWorkspaceIngestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        sourceItemId: "gwsrc_1",
        sourceKind: "wiki",
        sourceProvider: "gmail",
        rawEventCount: 2,
      }),
    );
  });

  it("writes terminal skipped jobs without reserving billing admission", async () => {
    let insertedJobValues: Record<string, unknown> | undefined;
    let sourceItemUpdate: Record<string, unknown> | undefined;
    const skippedJob = {
      id: "gwjob_1",
      status: "skipped",
      completedAt: new Date("2026-08-24T09:00:00.000Z"),
      lastError: null,
      skipReason: "routine_status_change",
    };
    const db = {
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          if (table === wikiSourceItems) {
            return {
              onConflictDoUpdate: () => ({ returning: async () => [{ id: "gwsrc_1" }] }),
            };
          }
          insertedJobValues = values;
          return {
            onConflictDoNothing: () => ({ returning: async () => [skippedJob] }),
          };
        },
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            if (table === wikiSourceItems) sourceItemUpdate = values;
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [skippedJob],
          }),
        }),
      }),
    };

    await expect(
      upsertWikiSourceItemAndEnqueue({
        workspaceId: "workspace_1",
        sourceConnectionId: "slack_team_1",
        integrationId: "integration_1",
        item: wikiItem(),
        rawPayload: {},
        skipReason: " routine_status_change ",
        now: new Date("2026-08-24T09:00:00.000Z"),
        db,
      }),
    ).resolves.toMatchObject({
      sourceItemId: "gwsrc_1",
      jobId: "gwjob_1",
      enqueued: false,
      skipped: true,
    });

    expect(insertedJobValues).toMatchObject({
      status: "skipped",
      skipReason: "routine_status_change",
      result: {
        skipped: true,
        reason: "routine_status_change",
        summary: "routine_status_change",
      },
    });
    expect(sourceItemUpdate).toMatchObject({
      lastIngestJobId: "gwjob_1",
      lastIngestStatus: "skipped",
      lastIngestError: "routine_status_change",
    });
    expect(reserveWorkspaceIngestionMock).not.toHaveBeenCalled();
  });
});

describe("claimNextWikiIngestJob", () => {
  it("excludes a workspace that already has a live running job", async () => {
    const execute = vi.fn(async (_query: SQL) => ({ rows: [] }));
    await expect(
      claimNextWikiIngestJob({
        leaseOwner: "runner_1",
        leaseId: "lease_1",
        now: new Date("2026-08-24T09:00:00.000Z"),
        db: { execute },
      }),
    ).resolves.toBeNull();

    const query = normalizedSql(execute.mock.calls[0]![0] as SQL);
    expect(query).toContain("reservation.status = 'consumed'");
    expect(query).toContain("job.source_provider <> 'slack'");
    expect(query).toContain("source.enabled = true");
    expect(query).toContain("source.provider = job.source_provider");
    expect(query).toContain("running.workspace_id = job.workspace_id");
    expect(query).toContain("running.status = 'running'");
    expect(query).toContain("running.id <> job.id");
    expect(query).not.toContain("running.lease_expires_at >=");
    expect(query).toContain("for update of job skip locked");
  });

  it("reclaims a running job after its lease expires", async () => {
    const occurredAt = "2026-08-24T08:00:00.000Z";
    const reclaimed = {
      id: "gwjob_expired",
      workspaceId: "workspace_1",
      sourceItemId: "gwsrc_1",
      status: "running",
      attempts: 2,
      nextRetryAt: new Date("2026-08-24T08:30:00.000Z"),
      leaseExpiresAt: new Date("2026-08-24T08:59:00.000Z"),
      heartbeatAt: new Date("2026-08-24T08:54:00.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-24T08:00:00.000Z"),
      updatedAt: new Date("2026-08-24T08:54:00.000Z"),
      occurredAt,
    };
    const execute = vi.fn(async (_query: SQL) => ({ rows: [reclaimed] }));

    await expect(
      claimNextWikiIngestJob({
        leaseOwner: "runner_2",
        leaseId: "lease_2",
        now: new Date("2026-08-24T09:00:00.000Z"),
        leaseTtlMs: 60_000,
        db: { execute },
      }),
    ).resolves.toEqual({ ...reclaimed, occurredAt: new Date(occurredAt) });

    const compiled = dialect.sqlToQuery(execute.mock.calls[0]![0] as SQL);
    expect(normalizeSql(compiled.sql)).toContain(
      "job.status = 'running' and job.lease_expires_at <",
    );
    expect(compiled.params).toEqual(
      expect.arrayContaining(["lease_2", "runner_2", new Date("2026-08-24T09:01:00.000Z")]),
    );
  });

  it("treats the concurrent workspace-running uniqueness race as no available job", async () => {
    const execute = vi.fn(async () => {
      throw Object.assign(new Error("duplicate running workspace"), { code: "23505" });
    });

    await expect(
      claimNextWikiIngestJob({
        leaseOwner: "runner_2",
        leaseId: "lease_2",
        now: new Date("2026-08-24T09:00:00.000Z"),
        db: { execute },
      }),
    ).resolves.toBeNull();
  });
});

describe("listWikiIngestActivityRows", () => {
  it("joins source metadata and applies a stable workspace-scoped cursor", async () => {
    const execute = vi.fn(async (_query: SQL) => ({
      rows: [
        {
          id: "gwjob_1",
          sourceProvider: "gmail",
          sourceType: "thread",
          title: "Launch update",
          occurredAt: "2026-08-24T08:00:00.000Z",
          status: "succeeded",
          attempts: 1,
          lastError: null,
          skipReason: null,
          result: { pages: [] },
          completedAt: "2026-08-24T09:01:00.000Z",
          createdAt: "2026-08-24T09:00:00.000Z",
          updatedAt: "2026-08-24T09:01:00.000Z",
        },
      ],
    }));

    await expect(
      listWikiIngestActivityRows({
        workspaceId: "workspace_1",
        limit: 21,
        before: {
          createdAt: new Date("2026-08-25T00:00:00.000Z"),
          id: "gwjob_cursor",
        },
        db: { execute },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "gwjob_1",
        title: "Launch update",
        createdAt: new Date("2026-08-24T09:00:00.000Z"),
      }),
    ]);

    const compiled = dialect.sqlToQuery(execute.mock.calls[0]![0] as SQL);
    expect(normalizeSql(compiled.sql)).toContain(
      "job.source_provider not in ('slack', 'opencompany-import')",
    );
    expect(normalizeSql(compiled.sql)).toContain("inner join goat.wiki_source_items as source");
    expect(normalizeSql(compiled.sql)).toContain("where job.workspace_id =");
    expect(normalizeSql(compiled.sql)).toContain("order by job.created_at desc, job.id desc");
    expect(compiled.params).toEqual(
      expect.arrayContaining([
        "workspace_1",
        new Date("2026-08-25T00:00:00.000Z"),
        "gwjob_cursor",
        21,
      ]),
    );
  });
});

describe("wiki ingest job lifecycle", () => {
  it("heartbeats only the active lease", async () => {
    const execute = vi.fn(async (_query: SQL) => ({ rows: [{ id: "gwjob_1" }] }));
    await expect(
      heartbeatWikiIngestJob({
        id: "gwjob_1",
        leaseId: "lease_1",
        leaseOwner: "runner_1",
        now: new Date("2026-08-24T09:00:00.000Z"),
        leaseTtlMs: 60_000,
        db: { execute },
      }),
    ).resolves.toBe(true);
    const query = normalizedSql(execute.mock.calls[0]![0] as SQL);
    expect(query).toContain("heartbeat_at =");
    expect(query).toContain("lease_id =");
    expect(query).toContain("lease_owner =");
    expect(query).toContain("status = 'running'");
  });

  it("requeues a shutdown-interrupted lease without consuming the attempt", async () => {
    const execute = vi.fn(async (_query: SQL) => ({ rows: [{ id: "gwjob_1" }] }));
    const now = new Date("2026-08-24T09:00:00.000Z");

    await expect(
      releaseWikiIngestJob({
        id: "gwjob_1",
        sourceItemId: "gwsrc_1",
        leaseId: "lease_1",
        leaseOwner: "runner_1",
        now,
        db: { execute },
      }),
    ).resolves.toBe(true);

    const compiled = dialect.sqlToQuery(execute.mock.calls[0]![0] as SQL);
    expect(normalizeSql(compiled.sql)).toContain("set status = 'queued'");
    expect(normalizeSql(compiled.sql)).toContain("attempts = greatest(attempts - 1, 0)");
    expect(compiled.params).toEqual(
      expect.arrayContaining([now, "gwjob_1", "gwsrc_1", "lease_1", "runner_1"]),
    );
  });

  it("completes and skips through lease-guarded terminal updates", async () => {
    const execute = vi.fn(async (_query: SQL) => ({ rows: [{ id: "gwjob_1" }] }));
    const lease = {
      id: "gwjob_1",
      sourceItemId: "gwsrc_1",
      leaseId: "lease_1",
      leaseOwner: "runner_1",
      now: new Date("2026-08-24T09:00:00.000Z"),
      db: { execute },
    };
    await expect(completeWikiIngestJob({ ...lease, result: { mutations: 2 } })).resolves.toBe(true);
    await expect(
      skipWikiIngestJob({
        ...lease,
        reason: "nothing durable",
        result: { skipped: true },
      }),
    ).resolves.toBe(true);

    expect(normalizedSql(execute.mock.calls[0]![0] as SQL)).toContain("set status = 'succeeded'");
    const skipQuery = normalizedSql(execute.mock.calls[1]![0] as SQL);
    expect(skipQuery).toContain("set status = 'skipped'");
    expect(skipQuery).toContain("last_ingest_status = 'skipped'");
  });

  it("requeues failures with 30-second exponential backoff capped at 15 minutes", async () => {
    const now = new Date("2026-08-24T09:00:00.000Z");
    expect(wikiIngestRetryAt(now, 1)).toEqual(new Date("2026-08-24T09:00:30.000Z"));
    expect(wikiIngestRetryAt(now, 2)).toEqual(new Date("2026-08-24T09:01:00.000Z"));
    expect(wikiIngestRetryAt(now, 20)).toEqual(new Date("2026-08-24T09:15:00.000Z"));

    const execute = vi.fn(async (_query: SQL) => ({ rows: [{ id: "gwjob_1" }] }));
    await expect(
      failWikiIngestJobWithBackoff({
        id: "gwjob_1",
        sourceItemId: "gwsrc_1",
        leaseId: "lease_1",
        leaseOwner: "runner_1",
        attempts: 2,
        error: "gateway unavailable",
        now,
        db: { execute },
      }),
    ).resolves.toBe(true);

    const compiled = dialect.sqlToQuery(execute.mock.calls[0]![0] as SQL);
    expect(normalizeSql(compiled.sql)).toContain("set status =");
    expect(compiled.params).toEqual(
      expect.arrayContaining([
        "queued",
        new Date("2026-08-24T09:01:00.000Z"),
        "gateway unavailable",
      ]),
    );
  });
});

function wikiItem() {
  return {
    sourceProvider: "gmail" as const,
    sourceType: "thread" as const,
    externalId: "window_1",
    sourceRef: "gmail:thread:thread_1",
    title: "Gmail thread",
    occurredAt: "2026-08-24T08:55:00.000Z",
    capturedAt: "2026-08-24T09:00:00.000Z",
    contentHash: "hash_1",
    contentHashInput: {},
    content: { messages: [] },
  };
}

function indexColumns(table: Parameters<typeof getTableConfig>[0], name: string) {
  const index = getTableConfig(table).indexes.find((candidate) => candidate.config.name === name);
  expect(index, `Missing ${name}`).toBeDefined();
  expect(index!.config.unique).toBe(true);
  return index!.config.columns.map((column) => (column as { name: string }).name);
}

function normalizedSql(query: SQL) {
  return normalizeSql(dialect.sqlToQuery(query).sql);
}

function normalizeSql(query: string) {
  return query.toLowerCase().replaceAll(/\s+/g, " ").trim();
}
