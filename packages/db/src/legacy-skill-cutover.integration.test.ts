import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("legacy Skill cutover migration", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(BASE_SCHEMA);
    for (const migrationName of [
      "0222_goat_immutable_skill_bundles.sql",
      "0223_goat_chat_skill_bundle_snapshots.sql",
      "0224_goat_plugins.sql",
      "0225_goat_chat_skill_bundle_names.sql",
    ]) {
      await applyMigration(database, migrationName);
    }
    await database.exec(SEED);
    await applyMigration(database, "0226_legacy_skill_cutover.sql");
  });

  afterAll(async () => {
    await database.close();
  });

  it("drops legacy Skill rows and their obsolete idempotency reservations", async () => {
    const result = await database.query<{
      skills_table: string | null;
      snapshots_table: string | null;
      legacy_commands: number;
      retained_commands: number;
      chat_messages: number;
    }>(`
      SELECT
        to_regclass('goat.skills')::text AS skills_table,
        to_regclass('goat.chat_session_skills')::text AS snapshots_table,
        (
          SELECT COUNT(*)::int
          FROM goat.knowledge_command_idempotency
          WHERE operation IN ('skill.create', 'skill.import')
        ) AS legacy_commands,
        (
          SELECT COUNT(*)::int
          FROM goat.knowledge_command_idempotency
          WHERE operation = 'brain_document.create'
        ) AS retained_commands,
        (SELECT COUNT(*)::int FROM goat.chat_messages) AS chat_messages
    `);

    expect(result.rows[0]).toEqual({
      skills_table: null,
      snapshots_table: null,
      legacy_commands: 0,
      retained_commands: 1,
      chat_messages: 1,
    });
    await expect(
      database.exec(`
        INSERT INTO goat.knowledge_command_idempotency (command_id, operation)
        VALUES ('command_rejected', 'skill.import')
      `),
    ).rejects.toThrow(/goat_knowledge_command_idempotency_operation_check/u);
  });

  it("keeps immutable rows restricted outside an explicitly ordered workspace delete", async () => {
    await expect(database.exec("DELETE FROM goat.plugins WHERE id = 'plugin_1'")).rejects.toThrow();
    await expect(
      database.exec("DELETE FROM goat.skill_bundles WHERE id = 'skill_bundle_1'"),
    ).rejects.toThrow();

    await expect(
      database.exec("DELETE FROM goat.workspaces WHERE id = 'workspace_1'"),
    ).resolves.toBeDefined();
    const result = await database.query<{
      sessions: number;
      bundle_snapshots: number;
      plugin_snapshots: number;
      bundles: number;
      plugins: number;
    }>(`
      SELECT
        (SELECT COUNT(*)::int FROM goat.chat_sessions) AS sessions,
        (SELECT COUNT(*)::int FROM goat.chat_session_skill_bundles) AS bundle_snapshots,
        (SELECT COUNT(*)::int FROM goat.chat_session_plugins) AS plugin_snapshots,
        (SELECT COUNT(*)::int FROM goat.skill_bundles) AS bundles,
        (SELECT COUNT(*)::int FROM goat.plugins) AS plugins
    `);
    expect(result.rows[0]).toEqual({
      sessions: 1,
      bundle_snapshots: 0,
      plugin_snapshots: 0,
      bundles: 0,
      plugins: 0,
    });
  });
});

async function applyMigration(database: PGlite, migrationName: string) {
  const migration = await readFile(
    path.resolve(import.meta.dirname, "../../..", `drizzle/${migrationName}`),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
}

const BASE_SCHEMA = `
  CREATE SCHEMA goat;
  CREATE TABLE goat.workspaces (id text PRIMARY KEY);
  CREATE TABLE goat.chat_sessions (id text PRIMARY KEY);
  CREATE TABLE goat.chat_messages (id text PRIMARY KEY);
  CREATE TABLE goat.skills (id text PRIMARY KEY);
  CREATE TABLE goat.chat_session_skills (chat_session_id text NOT NULL, skill_id text NOT NULL);
  CREATE TABLE goat.knowledge_command_idempotency (
    command_id text PRIMARY KEY,
    operation text NOT NULL,
    CONSTRAINT goat_knowledge_command_idempotency_operation_check
      CHECK (operation IN ('brain_document.create', 'skill.create', 'skill.import'))
  );
`;

const SEED = `
  INSERT INTO goat.workspaces (id) VALUES ('workspace_1');
  INSERT INTO goat.chat_sessions (id) VALUES ('chat_1');
  INSERT INTO goat.chat_messages (id) VALUES ('message_1');
  INSERT INTO goat.skills (id) VALUES ('legacy_skill_1');
  INSERT INTO goat.chat_session_skills (chat_session_id, skill_id)
  VALUES ('chat_1', 'legacy_skill_1');
  INSERT INTO goat.knowledge_command_idempotency (command_id, operation) VALUES
    ('command_skill_create', 'skill.create'),
    ('command_skill_import', 'skill.import'),
    ('command_brain', 'brain_document.create');

  INSERT INTO goat.skill_bundles (
    id, workspace_id, integrity, name, description, body, source_type, source_url,
    source_path, source_ref, resolved_commit
  ) VALUES (
    'skill_bundle_1', 'workspace_1',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'review', 'Review changes.', 'Review changes.', 'github',
    'https://github.com/example/skills', 'review', 'main',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );
  INSERT INTO goat.skill_installations (id, workspace_id, name, bundle_id)
  VALUES ('skill_installation_1', 'workspace_1', 'review', 'skill_bundle_1');
  INSERT INTO goat.chat_session_skill_bundles (
    chat_session_id, bundle_id, name, activated_message_id, source_kind
  ) VALUES ('chat_1', 'skill_bundle_1', 'review', 'message_1', 'standalone');

  INSERT INTO goat.plugins (
    id, workspace_id, name, manifest, source_type, source_url, source_path, source_ref,
    resolved_commit, integrity, install_report
  ) VALUES (
    'plugin_1', 'workspace_1', 'review-tools', '{"name":"review-tools"}'::jsonb,
    'github', 'https://github.com/example/plugins', '', 'main',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '{}'::jsonb
  );
  INSERT INTO goat.plugin_skills (
    workspace_id, plugin_id, skill_name, skill_path, skill_bundle_id
  ) VALUES ('workspace_1', 'plugin_1', 'review', 'skills/review', 'skill_bundle_1');
  INSERT INTO goat.chat_session_plugins (chat_session_id, plugin_id)
  VALUES ('chat_1', 'plugin_1');
`;
