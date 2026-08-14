import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BRAIN_WORKER_ADMISSION_CHANNEL } from "./worker-admission";

const migrationPath = path.resolve(
  import.meta.dirname,
  "../../..",
  "drizzle/0211_goat_brain_worker_admission.sql",
);

describe("opencompany Brain worker admission migration", () => {
  let database: PGlite;
  let unlisten: () => Promise<void>;
  const hints: string[] = [];

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(BASE_SCHEMA);
    const migration = await readFile(migrationPath, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
    unlisten = await database.listen(BRAIN_WORKER_ADMISSION_CHANNEL, (payload) => {
      hints.push(payload);
    });
  });

  beforeEach(async () => {
    hints.length = 0;
    await database.exec(`
      DELETE FROM goat.brain_import_runs;
      DELETE FROM goat.brain_ingest_jobs;
      DELETE FROM goat.google_drive_sync_cursors;
      DELETE FROM goat.brain_sources;
    `);
  });

  afterAll(async () => {
    await unlisten();
    await database.close();
  });

  it("publishes due import and ingest hints but not future, paused, or leased work", async () => {
    await database.exec(`
      INSERT INTO goat.brain_import_runs (id, status, next_run_at, lease_id)
      VALUES
        ('due', 'discovering', CURRENT_TIMESTAMP, NULL),
        ('future', 'discovering', CURRENT_TIMESTAMP + INTERVAL '1 hour', NULL),
        ('leased', 'ingesting', CURRENT_TIMESTAMP, 'lease_1');
      INSERT INTO goat.brain_ingest_jobs (id, status, plan_paused, next_run_at)
      VALUES
        ('due', 'queued', false, CURRENT_TIMESTAMP),
        ('paused', 'queued', true, CURRENT_TIMESTAMP),
        ('future', 'queued', false, CURRENT_TIMESTAMP + INTERVAL '1 hour');
    `);

    await vi.waitFor(() => expect(workerHints()).toEqual(["brain_import", "brain_ingest"]));
  });

  it("publishes when durable retry and plan admission transitions become claimable", async () => {
    await database.exec(`
      INSERT INTO goat.brain_import_runs (id, status, next_run_at)
      VALUES ('retry', 'failed', CURRENT_TIMESTAMP);
      INSERT INTO goat.brain_ingest_jobs (id, status, plan_paused, next_run_at)
      VALUES ('resume', 'queued', true, CURRENT_TIMESTAMP);
    `);
    hints.length = 0;

    await database.exec(`
      UPDATE goat.brain_import_runs
      SET status = 'discovering', next_run_at = CURRENT_TIMESTAMP
      WHERE id = 'retry';
      UPDATE goat.brain_ingest_jobs
      SET plan_paused = false
      WHERE id = 'resume';
    `);

    await vi.waitFor(() => expect(workerHints()).toEqual(["brain_import", "brain_ingest"]));
  });

  it("publishes Drive cursor and enabled-source hints without exposing row data", async () => {
    await database.exec(`
      INSERT INTO goat.google_drive_sync_cursors (id, wake_requested_at)
      VALUES ('cursor_1', NULL);
      UPDATE goat.google_drive_sync_cursors
      SET wake_requested_at = CURRENT_TIMESTAMP
      WHERE id = 'cursor_1';
      INSERT INTO goat.brain_sources (id, provider, enabled, config)
      VALUES
        ('drive_source', 'google_drive', true, '{"resourceIds":["private-file"]}'),
        ('slack_source', 'slack', true, '{}');
    `);

    await vi.waitFor(() =>
      expect(hints.map((payload) => JSON.parse(payload))).toEqual([
        { worker: "google_drive_sync" },
      ]),
    );
    expect(hints.join(" ")).not.toContain("cursor_1");
    expect(hints.join(" ")).not.toContain("private-file");
  });

  function workerHints() {
    return hints.map((payload) => (JSON.parse(payload) as { worker: string }).worker);
  }
});

const BASE_SCHEMA = `
  CREATE SCHEMA goat;
  CREATE TABLE goat.brain_import_runs (
    id text PRIMARY KEY,
    status text NOT NULL,
    next_run_at timestamptz NOT NULL,
    lease_id text
  );
  CREATE TABLE goat.brain_ingest_jobs (
    id text PRIMARY KEY,
    status text NOT NULL,
    plan_paused boolean NOT NULL DEFAULT false,
    next_run_at timestamptz NOT NULL,
    lease_id text
  );
  CREATE TABLE goat.google_drive_sync_cursors (
    id text PRIMARY KEY,
    wake_requested_at timestamptz
  );
  CREATE TABLE goat.brain_sources (
    id text PRIMARY KEY,
    provider text NOT NULL,
    enabled boolean NOT NULL,
    config jsonb NOT NULL DEFAULT '{}'::jsonb
  );
`;
