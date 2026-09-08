import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  import.meta.dirname,
  "../../..",
  "drizzle/0257_enforce_legacy_brain_ingestion_cutover.sql",
);

describe("legacy Brain ingestion cutover migration", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(BASE_SCHEMA);
    await database.exec(FIXTURE);
    const migration = await readFile(migrationPath, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  });

  afterAll(async () => {
    await database.close();
  });

  it("stops imports, jobs, and sources for workspaces with legacy Brain disabled", async () => {
    const importRun = await database.query(
      "SELECT status FROM goat.brain_import_runs WHERE id = 'disabled_import'",
    );
    const job = await database.query(
      "SELECT status, plan_paused, lease_id, result FROM goat.brain_ingest_jobs WHERE id = 'disabled_job'",
    );
    const sourceItem = await database.query(
      "SELECT last_ingest_status, last_ingest_error FROM goat.brain_source_items WHERE id = 'disabled_item'",
    );
    const source = await database.query(
      "SELECT enabled FROM goat.brain_sources WHERE id = 'disabled_source'",
    );
    const reservations = await database.query(
      "SELECT id, source_item_id, wiki_source_item_id FROM goat.workspace_ingestion_reservations WHERE workspace_id = 'disabled_workspace'",
    );

    expect(importRun.rows).toEqual([{ status: "canceled" }]);
    expect(job.rows).toEqual([
      {
        status: "skipped",
        plan_paused: false,
        lease_id: null,
        result: {
          skipped: true,
          reason: "legacy_brain_disabled",
          summary: "Stopped because legacy Brain is disabled for this workspace.",
        },
      },
    ]);
    expect(sourceItem.rows).toEqual([
      {
        last_ingest_status: "skipped",
        last_ingest_error: "Stopped because legacy Brain is disabled for this workspace.",
      },
    ]);
    expect(source.rows).toEqual([{ enabled: false }]);
    expect(reservations.rows).toEqual([
      {
        id: "disabled_wiki_reservation",
        source_item_id: null,
        wiki_source_item_id: "wiki_item",
      },
    ]);
  });

  it("leaves enabled legacy Brain work untouched", async () => {
    const importRun = await database.query(
      "SELECT status FROM goat.brain_import_runs WHERE id = 'enabled_import'",
    );
    const job = await database.query(
      "SELECT status, plan_paused, lease_id, result FROM goat.brain_ingest_jobs WHERE id = 'enabled_job'",
    );
    const source = await database.query(
      "SELECT enabled FROM goat.brain_sources WHERE id = 'enabled_source'",
    );
    const reservations = await database.query(
      "SELECT id, status FROM goat.workspace_ingestion_reservations WHERE workspace_id = 'enabled_workspace'",
    );

    expect(importRun.rows).toEqual([{ status: "ingesting" }]);
    expect(job.rows).toEqual([
      { status: "running", plan_paused: false, lease_id: "lease_enabled", result: {} },
    ]);
    expect(source.rows).toEqual([{ enabled: true }]);
    expect(reservations.rows).toEqual([{ id: "enabled_reservation", status: "pending" }]);
  });
});

const BASE_SCHEMA = `
  CREATE SCHEMA goat;
  CREATE TABLE goat.workspaces (
    id text PRIMARY KEY,
    legacy_brain_enabled boolean NOT NULL
  );
  CREATE TABLE goat.brains (
    id text PRIMARY KEY,
    workspace_id text NOT NULL
  );
  CREATE TABLE goat.brain_import_runs (
    id text PRIMARY KEY,
    brain_ref text,
    status text NOT NULL,
    lease_id text,
    lease_owner text,
    lease_expires_at timestamptz,
    last_error text,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL
  );
  CREATE TABLE goat.brain_source_items (
    id text PRIMARY KEY,
    last_ingest_job_id text,
    last_ingest_status text,
    last_ingested_at timestamptz,
    last_ingest_error text,
    updated_at timestamptz NOT NULL
  );
  CREATE TABLE goat.brain_ingest_jobs (
    id text PRIMARY KEY,
    workspace_id text,
    brain_ref text,
    source_item_id text NOT NULL,
    status text NOT NULL,
    plan_paused boolean NOT NULL,
    lease_id text,
    lease_owner text,
    lease_expires_at timestamptz,
    last_error text,
    result jsonb NOT NULL,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL
  );
  CREATE TABLE goat.brain_sources (
    id text PRIMARY KEY,
    brain_id text NOT NULL,
    enabled boolean NOT NULL,
    updated_at timestamptz NOT NULL
  );
  CREATE TABLE goat.workspace_ingestion_reservations (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    source_item_id text,
    wiki_source_item_id text,
    status text NOT NULL
  );
`;

const FIXTURE = `
  INSERT INTO goat.workspaces (id, legacy_brain_enabled)
  VALUES ('disabled_workspace', false), ('enabled_workspace', true);
  INSERT INTO goat.brains (id, workspace_id)
  VALUES ('disabled_brain', 'disabled_workspace'), ('enabled_brain', 'enabled_workspace');
  INSERT INTO goat.brain_import_runs (id, brain_ref, status, lease_id, lease_owner, updated_at)
  VALUES
    ('disabled_import', 'disabled_brain', 'ingesting', 'lease_disabled', 'runner', CURRENT_TIMESTAMP),
    ('enabled_import', 'enabled_brain', 'ingesting', 'lease_enabled', 'runner', CURRENT_TIMESTAMP);
  INSERT INTO goat.brain_source_items (id, last_ingest_job_id, last_ingest_status, updated_at)
  VALUES
    ('disabled_item', 'disabled_job', 'pending', CURRENT_TIMESTAMP),
    ('enabled_item', 'enabled_job', 'pending', CURRENT_TIMESTAMP);
  INSERT INTO goat.brain_ingest_jobs (
    id, workspace_id, brain_ref, source_item_id, status, plan_paused,
    lease_id, lease_owner, result, updated_at
  ) VALUES
    ('disabled_job', 'disabled_workspace', 'disabled_brain', 'disabled_item', 'running', true,
      'lease_disabled', 'runner', '{}'::jsonb, CURRENT_TIMESTAMP),
    ('enabled_job', 'enabled_workspace', 'enabled_brain', 'enabled_item', 'running', false,
      'lease_enabled', 'runner', '{}'::jsonb, CURRENT_TIMESTAMP);
  INSERT INTO goat.brain_sources (id, brain_id, enabled, updated_at)
  VALUES
    ('disabled_source', 'disabled_brain', true, CURRENT_TIMESTAMP),
    ('enabled_source', 'enabled_brain', true, CURRENT_TIMESTAMP);
  INSERT INTO goat.workspace_ingestion_reservations (
    id, workspace_id, source_item_id, wiki_source_item_id, status
  )
  VALUES
    ('disabled_reservation', 'disabled_workspace', 'disabled_item', NULL, 'pending'),
    ('disabled_wiki_reservation', 'disabled_workspace', NULL, 'wiki_item', 'pending'),
    ('enabled_reservation', 'enabled_workspace', 'enabled_item', NULL, 'pending');
`;
