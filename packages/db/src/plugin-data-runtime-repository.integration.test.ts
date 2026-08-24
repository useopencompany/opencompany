import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireWorkspacePluginDataLease,
  checkpointWorkspacePluginData,
  getWorkspacePluginDataRecord,
  initializeWorkspacePluginDataLease,
  releaseWorkspacePluginDataLease,
  renewWorkspacePluginDataLease,
} from "./plugin-data-runtime-repository";

describe("workspace Plugin data leases", () => {
  let database: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.workspaces (id text PRIMARY KEY);
      CREATE TABLE goat.chat_sessions (id text PRIMARY KEY);
      INSERT INTO goat.workspaces (id) VALUES ('workspace_1');
    `);
    for (const migrationName of [
      "0222_goat_immutable_skill_bundles.sql",
      "0224_goat_plugins.sql",
    ]) {
      const migration = await readFile(
        path.resolve(import.meta.dirname, "../../..", `drizzle/${migrationName}`),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await database.exec(statement);
      }
    }
    db = drizzle(database);
  });

  afterAll(async () => {
    await database.close();
  });

  it("serializes use and fences renewals, checkpoints, and releases", async () => {
    const now = new Date("2026-08-24T10:00:00.000Z");
    const initialized = await initializeWorkspacePluginDataLease(db, {
      workspaceId: "workspace_1",
      pluginName: "quality-tools",
      blobPathname: "plugin-data/workspace_1/quality-tools/0.tar",
      checksum: `sha256:${"a".repeat(64)}`,
      sizeBytes: 1024,
      leaseId: "lease_a",
      leaseOwner: "execution_a",
      leaseTtlMs: 60_000,
      now,
    });
    expect(initialized).toMatchObject({ generation: 0, leaseId: "lease_a" });

    await expect(
      acquireWorkspacePluginDataLease(db, {
        workspaceId: "workspace_1",
        pluginName: "quality-tools",
        leaseId: "lease_b",
        leaseOwner: "execution_b",
        leaseTtlMs: 60_000,
        now: new Date(now.getTime() + 1_000),
      }),
    ).resolves.toBeNull();
    await expect(
      renewWorkspacePluginDataLease(db, {
        workspaceId: "workspace_1",
        pluginName: "quality-tools",
        leaseId: "wrong_lease",
        leaseOwner: "execution_a",
        leaseTtlMs: 60_000,
        now,
      }),
    ).resolves.toBe(false);

    const checkpoint = await checkpointWorkspacePluginData(db, {
      workspaceId: "workspace_1",
      pluginName: "quality-tools",
      leaseId: "lease_a",
      leaseOwner: "execution_a",
      expectedGeneration: 0,
      blobPathname: "plugin-data/workspace_1/quality-tools/1.tar",
      checksum: `sha256:${"b".repeat(64)}`,
      sizeBytes: 2048,
      releaseLease: true,
      leaseTtlMs: 60_000,
      now: new Date(now.getTime() + 2_000),
    });
    expect(checkpoint).toMatchObject({ generation: 1 });
    await expect(
      checkpointWorkspacePluginData(db, {
        workspaceId: "workspace_1",
        pluginName: "quality-tools",
        leaseId: "lease_a",
        leaseOwner: "execution_a",
        expectedGeneration: 0,
        blobPathname: "plugin-data/workspace_1/quality-tools/stale.tar",
        checksum: `sha256:${"c".repeat(64)}`,
        sizeBytes: 2048,
        releaseLease: true,
        leaseTtlMs: 60_000,
        now: new Date(now.getTime() + 3_000),
      }),
    ).resolves.toBeNull();

    const acquired = await acquireWorkspacePluginDataLease(db, {
      workspaceId: "workspace_1",
      pluginName: "quality-tools",
      leaseId: "lease_b",
      leaseOwner: "execution_b",
      leaseTtlMs: 60_000,
      now: new Date(now.getTime() + 4_000),
    });
    expect(acquired).toMatchObject({ generation: 1, leaseId: "lease_b" });
    await expect(
      releaseWorkspacePluginDataLease(db, {
        workspaceId: "workspace_1",
        pluginName: "quality-tools",
        leaseId: "lease_a",
        leaseOwner: "execution_a",
      }),
    ).resolves.toBe(false);
    await expect(
      releaseWorkspacePluginDataLease(db, {
        workspaceId: "workspace_1",
        pluginName: "quality-tools",
        leaseId: "lease_b",
        leaseOwner: "execution_b",
      }),
    ).resolves.toBe(true);
    await expect(
      getWorkspacePluginDataRecord(db, {
        workspaceId: "workspace_1",
        pluginName: "quality-tools",
      }),
    ).resolves.toMatchObject({ generation: 1, leaseId: null, leaseOwner: null });
  });
});
