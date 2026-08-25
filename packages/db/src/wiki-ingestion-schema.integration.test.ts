import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  import.meta.dirname,
  "../../..",
  "drizzle/0231_goat_wiki_ingestion_spine.sql",
);

describe("0231_goat_wiki_ingestion_spine", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(BASE_SCHEMA);
    const migration = await readFile(migrationPath, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  });

  afterAll(async () => {
    await database.close();
  });

  it("enforces launch providers, dedup keys, and workspace/source cascades", async () => {
    await database.exec(`
      INSERT INTO goat.workspaces (id) VALUES ('workspace_1');
      INSERT INTO goat.users (workos_user_id) VALUES ('user_1');
      INSERT INTO goat.integrations (id, user_workos_id, provider)
      VALUES ('integration_1', 'user_1', 'slack');
      INSERT INTO goat.wiki_sources (
        id, workspace_id, provider, integration_id, user_workos_id, created_by_workos_id
      ) VALUES (
        'gwscfg_1', 'workspace_1', 'slack', 'integration_1', 'user_1', 'user_1'
      );
      INSERT INTO goat.wiki_source_items (
        id, workspace_id, source_provider, source_connection_id, integration_id,
        source_type, external_id, source_ref, occurred_at, content_hash,
        raw_payload, normalized_payload
      ) VALUES (
        'gwsrc_1', 'workspace_1', 'slack', 'team_1', 'integration_1',
        'conversation', 'window_1', 'slack:window:1', now(), 'hash_1', '{}'::jsonb, '{}'::jsonb
      );
      INSERT INTO goat.wiki_ingest_jobs (
        id, workspace_id, source_item_id, source_provider, source_connection_id,
        integration_id, content_hash
      ) VALUES (
        'gwjob_1', 'workspace_1', 'gwsrc_1', 'slack', 'team_1', 'integration_1', 'hash_1'
      );
      INSERT INTO goat.wiki_source_event_claims (
        id, workspace_id, source_provider, event_key, source_item_id
      ) VALUES (
        'gwsec_1', 'workspace_1', 'slack', 'message_1', 'gwsrc_1'
      );
      INSERT INTO goat.workspace_ingestion_reservations (
        id, workspace_id, source_item_id, wiki_source_item_id, source_provider,
        raw_event_count, status, consumed_at
      ) VALUES (
        'gir_1', 'workspace_1', NULL, 'gwsrc_1', 'slack', 1, 'consumed', now()
      );
    `);

    await expect(
      database.exec(`
        INSERT INTO goat.wiki_sources (
          id, workspace_id, provider, integration_id, user_workos_id, created_by_workos_id
        ) VALUES (
          'gwscfg_bad', 'workspace_1', 'google_drive', 'integration_1', 'user_1', 'user_1'
        )
      `),
    ).rejects.toThrow();
    await expect(
      database.exec(`
        INSERT INTO goat.wiki_source_items (
          id, workspace_id, source_provider, source_connection_id, integration_id,
          source_type, external_id, source_ref, occurred_at, content_hash,
          raw_payload, normalized_payload
        ) VALUES (
          'gwsrc_duplicate', 'workspace_1', 'slack', 'team_1', 'integration_1',
          'conversation', 'window_1', 'slack:window:1', now(), 'hash_1', '{}'::jsonb, '{}'::jsonb
        )
      `),
    ).rejects.toThrow();

    await database.exec(`
      INSERT INTO goat.wiki_ingest_jobs (
        id, workspace_id, source_item_id, source_provider, source_connection_id,
        integration_id, content_hash, status
      ) VALUES (
        'gwjob_running_1', 'workspace_1', 'gwsrc_1', 'slack', 'team_1',
        'integration_1', 'hash_running_1', 'running'
      )
    `);
    await expect(
      database.exec(`
        INSERT INTO goat.wiki_ingest_jobs (
          id, workspace_id, source_item_id, source_provider, source_connection_id,
          integration_id, content_hash, status
        ) VALUES (
          'gwjob_running_2', 'workspace_1', 'gwsrc_1', 'slack', 'team_1',
          'integration_1', 'hash_running_2', 'running'
        )
      `),
    ).rejects.toThrow();

    await database.exec("DELETE FROM goat.wiki_source_items WHERE id = 'gwsrc_1'");
    await expect(count(database, "wiki_ingest_jobs")).resolves.toBe(0);
    await expect(count(database, "workspace_ingestion_reservations")).resolves.toBe(0);
    await expect(
      database.query<{ source_item_id: string | null }>(
        "SELECT source_item_id FROM goat.wiki_source_event_claims WHERE id = 'gwsec_1'",
      ),
    ).resolves.toMatchObject({ rows: [{ source_item_id: null }] });

    await database.exec("DELETE FROM goat.workspaces WHERE id = 'workspace_1'");
    await expect(count(database, "wiki_sources")).resolves.toBe(0);
    await expect(count(database, "wiki_source_event_claims")).resolves.toBe(0);
  });
});

async function count(database: PGlite, table: string) {
  const result = await database.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM "goat".${table}`,
  );
  return result.rows[0]?.count ?? 0;
}

const BASE_SCHEMA = `
  CREATE SCHEMA goat;
  CREATE TABLE goat.workspaces (id text PRIMARY KEY);
  CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);
  CREATE TABLE goat.integrations (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id) ON DELETE CASCADE,
    provider text NOT NULL,
    UNIQUE (id, user_workos_id, provider)
  );
  CREATE TABLE goat.brain_source_items (id text PRIMARY KEY);
  CREATE TABLE goat.workspace_ingestion_reservations (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
    source_item_id text NOT NULL,
    source_provider text NOT NULL,
    raw_event_count integer NOT NULL,
    status text NOT NULL,
    consumed_at timestamp with time zone,
    billed_overage_raw_event_count integer DEFAULT 0 NOT NULL,
    billed_overage_usd_micros bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT goat_ingestion_reservations_source_item_id_goat_brain_source_items_id_fk
      FOREIGN KEY (source_item_id) REFERENCES goat.brain_source_items(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX goat_ingestion_reservations_workspace_source_idx
    ON goat.workspace_ingestion_reservations (workspace_id, source_item_id);
`;
