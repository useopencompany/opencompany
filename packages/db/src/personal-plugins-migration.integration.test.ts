import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createTestPGlite } from "./test-pglite";

it("quarantines legacy plugin data and credentials without transferring ownership", async () => {
  const database = await createTestPGlite();
  try {
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);
      CREATE TABLE goat.plugins (id text PRIMARY KEY, workspace_id text, name text, status text);
      CREATE UNIQUE INDEX plugins_workspace_live_name_idx ON goat.plugins (workspace_id, name) WHERE status <> 'archived';
      CREATE TABLE goat.workspace_plugin_data (
        workspace_id text, plugin_name text, blob_pathname text,
        CONSTRAINT goat_workspace_plugin_data_workspace_id_plugin_name_pk PRIMARY KEY(workspace_id, plugin_name)
      );
      CREATE TABLE goat.infisical_connections (workspace_id text PRIMARY KEY, encrypted_auth_bundle jsonb);
      INSERT INTO goat.users VALUES ('alice'), ('bob');
      INSERT INTO goat.plugins VALUES ('legacy', 'workspace', 'linear', 'enabled');
      INSERT INTO goat.workspace_plugin_data VALUES ('workspace', 'linear', 'private-legacy.tar');
      INSERT INTO goat.infisical_connections VALUES ('workspace', '{"ciphertext":"synthetic-legacy-ciphertext"}');
    `);
    const migration = await readFile(
      new URL("../../../drizzle/0264_personal_plugins.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await database.exec(statement);
    expect((await database.query("SELECT owner_user_id FROM goat.plugins")).rows).toEqual([
      { owner_user_id: null },
    ]);
    expect(
      (await database.query("SELECT owner_user_id, blob_pathname FROM goat.workspace_plugin_data"))
        .rows,
    ).toEqual([{ owner_user_id: "", blob_pathname: "private-legacy.tar" }]);
    expect(
      (
        await database.query(
          "SELECT owner_user_id, encrypted_auth_bundle FROM goat.infisical_connections",
        )
      ).rows,
    ).toEqual([
      { owner_user_id: "", encrypted_auth_bundle: { ciphertext: "synthetic-legacy-ciphertext" } },
    ]);
    expect(
      (await database.query("SELECT personal_enabled FROM goat.plugin_ownership_rollout")).rows,
    ).toEqual([{ personal_enabled: false }]);
    await database.exec(`
      INSERT INTO goat.plugins VALUES ('alice-install', 'workspace', 'linear', 'enabled', 'alice'), ('bob-install', 'workspace', 'linear', 'enabled', 'bob');
      INSERT INTO goat.workspace_plugin_data VALUES ('workspace', 'linear', 'alice.tar', 'alice'), ('workspace', 'linear', 'bob.tar', 'bob');
      INSERT INTO goat.infisical_connections VALUES ('workspace', '{"ciphertext":"alice"}', 'alice'), ('workspace', '{"ciphertext":"bob"}', 'bob');
    `);
    expect(
      (await database.query("SELECT count(*)::int AS count FROM goat.workspace_plugin_data")).rows,
    ).toEqual([{ count: 3 }]);
    await expect(
      database.exec(
        "INSERT INTO goat.plugins VALUES ('duplicate', 'workspace', 'linear', 'enabled', 'alice')",
      ),
    ).rejects.toThrow(/unique/u);
  } finally {
    await database.close();
  }
});
