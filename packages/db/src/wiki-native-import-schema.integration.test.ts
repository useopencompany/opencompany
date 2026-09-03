import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  import.meta.dirname,
  "../../..",
  "drizzle/0244_wiki_native_company_imports.sql",
);

describe("0244_wiki_native_company_imports", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(BASE_SCHEMA);
    await database.exec(await readFile(migrationPath, "utf8"));
  });

  afterAll(async () => database.close());

  it("supports a workspace import and its internal Wiki ingest job without a Brain", async () => {
    await database.exec(`
      INSERT INTO goat.brain_import_runs (
        id, brain_ref, workspace_id, user_workos_id, status
      ) VALUES ('gbimp_wiki', NULL, 'workspace_1', 'user_1', 'ingesting');
      INSERT INTO goat.brain_source_items (id) VALUES ('gbsrc_research');
      INSERT INTO goat.brain_import_candidates (
        id, import_run_id, source_item_id, provider
      ) VALUES ('gbimpc_research', 'gbimp_wiki', 'gbsrc_research', 'public_web');
      INSERT INTO goat.wiki_source_items (
        id, workspace_id, source_provider, source_connection_id, integration_id,
        source_type, external_id, source_ref, content_hash
      ) VALUES (
        'gwsrc_research', 'workspace_1', 'opencompany-import', 'gbimp_wiki', NULL,
        'run', 'gbimp_wiki:research', 'opencompany-import:run:gbimp_wiki:research', 'hash_1'
      );
      INSERT INTO goat.wiki_ingest_jobs (
        id, workspace_id, source_item_id, source_provider, source_connection_id,
        integration_id, import_run_id, content_hash
      ) VALUES (
        'gwjob_research', 'workspace_1', 'gwsrc_research', 'opencompany-import', 'gbimp_wiki',
        NULL, 'gbimp_wiki', 'hash_1'
      );
      INSERT INTO goat.workspace_ingestion_reservations (
        id, workspace_id, wiki_source_item_id, source_provider
      ) VALUES (
        'reservation_1', 'workspace_1', 'gwsrc_research', 'opencompany-import'
      );
      UPDATE goat.brain_import_candidates
      SET wiki_ingest_job_id = 'gwjob_research'
      WHERE id = 'gbimpc_research';
    `);

    await expect(
      database.query<{ wiki_ingest_job_id: string }>(
        "SELECT wiki_ingest_job_id FROM goat.brain_import_candidates WHERE id = 'gbimpc_research'",
      ),
    ).resolves.toMatchObject({ rows: [{ wiki_ingest_job_id: "gwjob_research" }] });
  });

  it("rejects mixed targets and import jobs that bypass the internal provider contract", async () => {
    await expect(
      database.exec(`
        INSERT INTO goat.brain_import_runs (
          id, brain_ref, workspace_id, user_workos_id
        ) VALUES ('gbimp_bad', 'brain_1', 'workspace_1', 'user_1')
      `),
    ).rejects.toThrow();
    await expect(
      database.exec(`
        INSERT INTO goat.wiki_source_items (
          id, workspace_id, source_provider, source_connection_id, integration_id,
          source_type, external_id, source_ref, content_hash
        ) VALUES (
          'gwsrc_bad', 'workspace_1', 'opencompany-import', 'gbimp_wiki', 'integration_1',
          'run', 'bad', 'bad', 'hash_bad'
        )
      `),
    ).rejects.toThrow();
  });
});

const BASE_SCHEMA = `
  CREATE SCHEMA goat;
  CREATE TABLE goat.workspaces (id text PRIMARY KEY);
  CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);
  CREATE TABLE goat.integrations (id text PRIMARY KEY);
  CREATE TABLE goat.brains (id text PRIMARY KEY);
  CREATE TABLE goat.brain_source_items (id text PRIMARY KEY);
  CREATE TABLE goat.brain_ingest_jobs (id text PRIMARY KEY);
  INSERT INTO goat.workspaces VALUES ('workspace_1');
  INSERT INTO goat.users VALUES ('user_1');
  INSERT INTO goat.integrations VALUES ('integration_1');
  INSERT INTO goat.brains VALUES ('brain_1');

  CREATE TABLE goat.brain_import_runs (
    id text PRIMARY KEY,
    brain_ref text NOT NULL REFERENCES goat.brains(id) ON DELETE CASCADE,
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'discovering',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX goat_brain_import_runs_active_brain_idx
    ON goat.brain_import_runs (brain_ref)
    WHERE status IN ('discovering', 'awaiting_confirmation', 'ingesting', 'finalizing');
  CREATE TABLE goat.brain_import_candidates (
    id text PRIMARY KEY,
    import_run_id text NOT NULL REFERENCES goat.brain_import_runs(id) ON DELETE CASCADE,
    source_item_id text NOT NULL REFERENCES goat.brain_source_items(id) ON DELETE CASCADE,
    provider text NOT NULL
  );
  CREATE TABLE goat.wiki_source_items (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
    source_provider text NOT NULL,
    source_connection_id text NOT NULL,
    integration_id text NOT NULL REFERENCES goat.integrations(id) ON DELETE CASCADE,
    source_type text NOT NULL,
    external_id text NOT NULL,
    source_ref text NOT NULL,
    content_hash text NOT NULL,
    CONSTRAINT opencompany_wiki_source_items_source_provider_check
      CHECK (source_provider IN ('gmail', 'slack', 'jamie', 'granola', 'linear', 'github')),
    CONSTRAINT opencompany_wiki_source_items_source_type_check
      CHECK (source_type IN ('meeting', 'conversation', 'issue', 'activity', 'thread'))
  );
  CREATE TABLE goat.wiki_ingest_jobs (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
    source_item_id text NOT NULL REFERENCES goat.wiki_source_items(id) ON DELETE CASCADE,
    source_provider text NOT NULL,
    source_connection_id text NOT NULL,
    integration_id text NOT NULL,
    content_hash text NOT NULL,
    CONSTRAINT opencompany_wiki_ingest_jobs_source_provider_check
      CHECK (source_provider IN ('gmail', 'slack', 'jamie', 'granola', 'linear', 'github'))
  );
  CREATE TABLE goat.workspace_ingestion_reservations (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
    wiki_source_item_id text REFERENCES goat.wiki_source_items(id) ON DELETE CASCADE,
    source_provider text NOT NULL,
    CONSTRAINT goat_ingestion_reservations_source_provider_check
      CHECK (source_provider IN ('jamie', 'slack', 'linear', 'github', 'gmail', 'google_drive', 'hubspot', 'granola', 'fathom', 'attio'))
  );
`;
