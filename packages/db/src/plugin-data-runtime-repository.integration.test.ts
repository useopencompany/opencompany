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
import { createTestPGlite } from "./test-pglite";

describe("workspace Plugin data leases", () => {
  let database: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    database = await createTestPGlite();
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.workspaces (id text PRIMARY KEY);
      CREATE TABLE goat.chat_sessions (id text PRIMARY KEY);
      CREATE TABLE goat.workspace_members (workspace_id text, user_workos_id text, role text);
      INSERT INTO goat.workspace_members VALUES ('workspace_1', 'user_1', 'member'), ('workspace_1', 'user_2', 'member');
      INSERT INTO goat.workspaces (id) VALUES ('workspace_1');
    `);
    for (const migrationName of [
      "0226_goat_immutable_skill_bundles.sql",
      "0228_goat_plugins.sql",
    ]) {
      const migration = await readFile(
        path.resolve(import.meta.dirname, "../../..", `drizzle/${migrationName}`),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await database.exec(statement);
      }
    }
    await database.exec(`
      ALTER TABLE goat.plugins ADD COLUMN owner_user_id text;
      DROP INDEX goat.plugins_workspace_live_name_idx;
      CREATE UNIQUE INDEX plugins_workspace_live_name_idx ON goat.plugins (workspace_id, owner_user_id, name) WHERE status <> 'archived';
      ALTER TABLE goat.workspace_plugin_data ADD COLUMN owner_user_id text NOT NULL DEFAULT 'user_1';
      ALTER TABLE goat.workspace_plugin_data DROP CONSTRAINT goat_workspace_plugin_data_workspace_id_plugin_name_pk;
      ALTER TABLE goat.workspace_plugin_data ADD PRIMARY KEY (workspace_id, owner_user_id, plugin_name);
    `);
    await database.exec(`
      INSERT INTO goat.plugins (id, workspace_id, owner_user_id, name, manifest, source_type, source_url, source_path, source_ref, resolved_commit, integrity, install_report)
      VALUES ('plugin_1', 'workspace_1', 'user_1', 'quality-tools', '{}', 'github', 'https://github.com/example/plugins', '', 'main', '${"a".repeat(40)}', 'sha256:${"b".repeat(64)}', '{}'),
             ('plugin_2', 'workspace_1', 'user_2', 'quality-tools', '{}', 'github', 'https://github.com/example/plugins', '', 'main', '${"a".repeat(40)}', 'sha256:${"b".repeat(64)}', '{}');
    `);
    await database.exec("UPDATE goat.plugins SET mcp_approved_integrity = integrity");
    db = drizzle(database);
  });

  afterAll(async () => {
    await database.close();
  });

  it("keeps same-name data and lease fences personal, and checks revocation", async () => {
    const common = {
      workspaceId: "workspace_1",
      pluginName: "quality-tools",
      checksum: `sha256:${"c".repeat(64)}`,
      sizeBytes: 0,
      leaseId: "same-lease",
      leaseOwner: "same-session",
      leaseTtlMs: 60000,
    };
    const first = await initializeWorkspacePluginDataLease(db, {
      ...common,
      userId: "user_1",
      pluginId: "plugin_1",
      blobPathname: "alice.tar",
    });
    expect(first).not.toBeNull();
    expect(
      await getWorkspacePluginDataRecord(db, { ...common, userId: "user_2", pluginId: "plugin_2" }),
    ).toBeNull();
    expect(
      await releaseWorkspacePluginDataLease(db, {
        ...common,
        userId: "user_2",
        pluginId: "plugin_2",
      }),
    ).toBe(false);
    const second = await initializeWorkspacePluginDataLease(db, {
      ...common,
      userId: "user_2",
      pluginId: "plugin_2",
      blobPathname: "bob.tar",
    });
    expect(second?.blobPathname).toBe("bob.tar");
    await database.exec("DELETE FROM goat.workspace_members WHERE user_workos_id = 'user_2'");
    expect(
      await getWorkspacePluginDataRecord(db, { ...common, userId: "user_2", pluginId: "plugin_2" }),
    ).toBeNull();
    expect(
      await renewWorkspacePluginDataLease(db, {
        ...common,
        userId: "user_2",
        pluginId: "plugin_2",
      }),
    ).toBe(false);
    await database.exec("DELETE FROM goat.workspace_plugin_data");
  });

  it("rejects a running package after approval revocation or replacement by the same owner", async () => {
    const access = {
      workspaceId: "workspace_1",
      userId: "user_1",
      pluginId: "plugin_1",
      pluginName: "quality-tools",
      leaseId: "revocable",
      leaseOwner: "old-session",
      leaseTtlMs: 60_000,
    };
    const lease = await initializeWorkspacePluginDataLease(db, {
      ...access,
      blobPathname: "approved.tar",
      checksum: `sha256:${"a".repeat(64)}`,
      sizeBytes: 0,
    });
    expect(lease?.pluginId).toBe("plugin_1");
    await database.exec(
      "UPDATE goat.plugins SET mcp_approved_integrity = NULL WHERE id = 'plugin_1'",
    );
    expect(await renewWorkspacePluginDataLease(db, access)).toBe(false);
    expect(await getWorkspacePluginDataRecord(db, access)).toBeNull();
    expect(
      await checkpointWorkspacePluginData(db, {
        ...access,
        expectedGeneration: 0,
        blobPathname: "unapproved.tar",
        checksum: `sha256:${"b".repeat(64)}`,
        sizeBytes: 0,
        releaseLease: true,
      }),
    ).toBeNull();
    await database.exec(`
      UPDATE goat.plugins SET status = 'archived', archived_at = now() WHERE id = 'plugin_1';
      INSERT INTO goat.plugins (id, workspace_id, owner_user_id, name, manifest, source_type, source_url, source_path, source_ref, resolved_commit, integrity, install_report, mcp_approved_integrity)
      SELECT 'replacement', workspace_id, owner_user_id, name, manifest, source_type, source_url, source_path, source_ref, resolved_commit, integrity, install_report, integrity FROM goat.plugins WHERE id = 'plugin_1';
    `);
    expect(await renewWorkspacePluginDataLease(db, access)).toBe(false);
    const replacement = await acquireWorkspacePluginDataLease(db, {
      ...access,
      pluginId: "replacement",
    });
    expect(replacement).toMatchObject({ pluginId: "replacement", blobPathname: "approved.tar" });
    await database.exec(`DELETE FROM goat.workspace_plugin_data;
      DELETE FROM goat.plugins WHERE id = 'replacement';
      UPDATE goat.plugins SET status = 'enabled', archived_at = NULL, mcp_approved_integrity = integrity WHERE id = 'plugin_1';`);
  });

  it("serializes use and fences renewals, checkpoints, and releases", async () => {
    const now = new Date("2026-08-24T10:00:00.000Z");
    const initialized = await initializeWorkspacePluginDataLease(db, {
      userId: "user_1",
      pluginId: "plugin_1",
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
        userId: "user_1",
        pluginId: "plugin_1",
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
        userId: "user_1",
        pluginId: "plugin_1",
        workspaceId: "workspace_1",
        pluginName: "quality-tools",
        leaseId: "wrong_lease",
        leaseOwner: "execution_a",
        leaseTtlMs: 60_000,
        now,
      }),
    ).resolves.toBe(false);

    const checkpoint = await checkpointWorkspacePluginData(db, {
      userId: "user_1",
      pluginId: "plugin_1",
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
        userId: "user_1",
        pluginId: "plugin_1",
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
      userId: "user_1",
      pluginId: "plugin_1",
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
        userId: "user_1",
        pluginId: "plugin_1",
        workspaceId: "workspace_1",
        pluginName: "quality-tools",
        leaseId: "lease_a",
        leaseOwner: "execution_a",
      }),
    ).resolves.toBe(false);
    await expect(
      releaseWorkspacePluginDataLease(db, {
        userId: "user_1",
        pluginId: "plugin_1",
        workspaceId: "workspace_1",
        pluginName: "quality-tools",
        leaseId: "lease_b",
        leaseOwner: "execution_b",
      }),
    ).resolves.toBe(true);
    await expect(
      getWorkspacePluginDataRecord(db, {
        userId: "user_1",
        pluginId: "plugin_1",
        workspaceId: "workspace_1",
        pluginName: "quality-tools",
      }),
    ).resolves.toMatchObject({ generation: 1, leaseId: null, leaseOwner: null });
  });
});
