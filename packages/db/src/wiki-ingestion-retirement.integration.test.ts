import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { createTestPGlite } from "./test-pglite";

describe("Wiki ingestion retirement migration", () => {
  const database = createTestPGlite();
  afterAll(async () => (await database).close());
  it("cancels old work, retains pages, and prevents older servers from re-enabling ingestion", async () => {
    const db = await database;
    await db.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.workflows (trigger text, status text, updated_at timestamptz);
      CREATE TABLE goat.wiki_sources (enabled boolean DEFAULT true, updated_at timestamptz);
      CREATE TABLE goat.wiki_ingest_jobs (status text, lease_id text, lease_owner text, lease_expires_at timestamptz, completed_at timestamptz, updated_at timestamptz, last_error text, result jsonb DEFAULT '{}');
      CREATE TABLE goat.brain_import_runs (workspace_id text, brain_ref text, status text, lease_id text, lease_owner text, lease_expires_at timestamptz, completed_at timestamptz, updated_at timestamptz, last_error text);
      CREATE TABLE goat.wiki_pages (body text);
      INSERT INTO goat.wiki_sources (enabled) VALUES (true);
      INSERT INTO goat.wiki_ingest_jobs (status) VALUES ('queued'), ('running'), ('succeeded');
      INSERT INTO goat.brain_import_runs (workspace_id, brain_ref, status) VALUES ('workspace_1', NULL, 'ingesting'), (NULL, 'brain_1', 'ingesting');
      INSERT INTO goat.wiki_pages VALUES ('Existing knowledge');
    `);
    await db.exec(
      await readFile(
        new URL("../../../drizzle/0273_retire_wiki_ingestion.sql", import.meta.url),
        "utf8",
      ),
    );
    expect((await db.query("SELECT enabled FROM goat.wiki_sources")).rows).toEqual([
      { enabled: false },
    ]);
    expect(
      (await db.query("SELECT status FROM goat.wiki_ingest_jobs ORDER BY status")).rows,
    ).toEqual([{ status: "skipped" }, { status: "skipped" }, { status: "succeeded" }]);
    expect(
      (await db.query("SELECT status FROM goat.brain_import_runs ORDER BY status")).rows,
    ).toEqual([{ status: "canceled" }, { status: "ingesting" }]);
    expect((await db.query("SELECT body FROM goat.wiki_pages")).rows).toEqual([
      { body: "Existing knowledge" },
    ]);
    await expect(db.exec("UPDATE goat.wiki_sources SET enabled = true")).rejects.toThrow(
      /retired_check/,
    );
    await expect(
      db.exec("INSERT INTO goat.wiki_ingest_jobs (status) VALUES ('queued')"),
    ).rejects.toThrow(/retired_check/);
  });
});
