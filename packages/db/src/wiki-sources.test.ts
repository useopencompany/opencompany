import type { SQL } from "drizzle-orm";
import { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
vi.mock("./client", () => ({ getDb: getDbMock }));

const {
  WIKI_SOURCE_DISABLED_INGEST_REASON,
  deleteWikiSource,
  ensureWikiSourceEnabledOnConnect,
  listEnabledWikiSourcesForIntegration,
  setWikiSourceEnabled,
  upsertWikiSource,
} = await import("./wiki-sources");

describe("upsertWikiSource", () => {
  it("persists a source without opening a transaction on neon-http", async () => {
    const returning = vi.fn(async () => [{ id: "gwscfg_1" }]);
    const transaction = vi.fn(() => {
      throw new Error("No transactions support in neon-http driver");
    });
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({ returning })),
        })),
      })),
      transaction,
    };
    Object.setPrototypeOf(db, NeonHttpDatabase.prototype);
    getDbMock.mockReturnValue(db);

    await expect(
      upsertWikiSource({
        workspaceId: "workspace_1",
        provider: "linear",
        integrationId: "integration_1",
        userWorkosId: "user_1",
        createdByWorkosId: "user_1",
        enabled: true,
        config: { teams: ["engineering"] },
        now: new Date("2026-08-24T09:00:00.000Z"),
      }),
    ).resolves.toEqual({ id: "gwscfg_1", created: true });

    expect(transaction).not.toHaveBeenCalled();
    expect(returning).toHaveBeenCalledOnce();
  });
});

describe("ensureWikiSourceEnabledOnConnect", () => {
  it("inserts an enabled meeting source without overwriting an existing pause", async () => {
    const returning = vi.fn(async () => []);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const db = { insert: vi.fn(() => ({ values })) };

    await expect(
      ensureWikiSourceEnabledOnConnect({
        workspaceId: "workspace_1",
        provider: "granola",
        integrationId: "integration_1",
        userWorkosId: "user_1",
        createdByWorkosId: "user_1",
        now: new Date("2026-08-24T09:00:00.000Z"),
        db,
      }),
    ).resolves.toBe(false);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "granola", enabled: true }),
    );
    expect(onConflictDoNothing).toHaveBeenCalledOnce();
    expect(db).not.toHaveProperty("update");
  });
});

describe("wiki source lifecycle", () => {
  it("terminally cancels queued and running jobs when disabled", async () => {
    let canceledQuery: SQL | undefined;
    const execute = vi.fn(async (query: SQL) => {
      canceledQuery = query;
      return [];
    });
    const returning = vi.fn(async () => [{ id: "gwscfg_1", integrationId: "integration_1" }]);
    const db = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning })),
        })),
      })),
      execute,
    };

    await expect(
      setWikiSourceEnabled({
        workspaceId: "workspace_1",
        sourceId: "gwscfg_1",
        enabled: false,
        now: new Date("2026-08-24T09:00:00.000Z"),
        db,
      }),
    ).resolves.toBe(true);

    const compiled = new PgDialect().sqlToQuery(canceledQuery!);
    expect(compiled.sql).toContain("UPDATE goat.wiki_ingest_jobs AS job");
    expect(compiled.sql).toContain("job.status IN ('queued', 'running')");
    expect(compiled.sql).toContain("UPDATE goat.wiki_source_items AS source");
    expect(compiled.sql).toContain("'reason', $2::text");
    expect(compiled.sql).toContain("'summary', $3::text");
    expect(compiled.params).toEqual(
      expect.arrayContaining(["workspace_1", "integration_1", WIKI_SOURCE_DISABLED_INGEST_REASON]),
    );
  });

  it("cancels active jobs before a deleted source transaction completes", async () => {
    const execute = vi.fn(async () => []);
    const returning = vi.fn(async () => [{ id: "gwscfg_1", integrationId: "integration_1" }]);
    const db = {
      delete: vi.fn(() => ({
        where: vi.fn(() => ({ returning })),
      })),
      execute,
    };

    await expect(
      deleteWikiSource({
        workspaceId: "workspace_1",
        sourceId: "gwscfg_1",
        now: new Date("2026-08-24T09:00:00.000Z"),
        db,
      }),
    ).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns only enabled routes for an integration", async () => {
    const rows = [
      {
        id: "gwscfg_1",
        workspaceId: "workspace_1",
        provider: "gmail",
        integrationId: "integration_1",
        userWorkosId: "user_1",
        enabled: true,
        config: { channels: ["C123"] },
        integrationStatus: "connected",
        integrationAccountName: "Acme",
        integrationAccountEmail: null,
        integrationConnectionLabel: "Acme Gmail",
        integrationWorkspaceId: null,
        ownerFirstName: "Ada",
        ownerLastName: "Lovelace",
        ownerEmail: "ada@example.com",
        ownerAvatarUrl: null,
      },
    ];
    const query = {
      innerJoin: vi.fn(),
      where: vi.fn(async () => rows),
    };
    query.innerJoin.mockReturnValue(query);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => query),
      })),
    };

    await expect(listEnabledWikiSourcesForIntegration("integration_1", db)).resolves.toEqual([
      expect.objectContaining({
        workspaceId: "workspace_1",
        integrationId: "integration_1",
        ownerName: "Ada Lovelace",
      }),
    ]);
    expect(query.where).toHaveBeenCalledOnce();
  });
});
