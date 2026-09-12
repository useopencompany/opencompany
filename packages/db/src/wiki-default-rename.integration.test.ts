// The 0272 migration renames every workspace's default wiki from "Wiki" to
// "Company" and moves its slug with it. Against embedded Postgres running the
// real SQL, because the interesting cases are the ones it must leave alone: a
// deliberately renamed default wiki, and a workspace that already holds a wiki
// slugged "company" -- where the unique index on (workspace_id, slug) would
// otherwise fail the whole migration.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestPGlite } from "./test-pglite";

const BASE_MIGRATIONS = [
  "0195_goat_wiki.sql",
  "0220_goat_wiki_folders.sql",
  "0269_wiki_first_class_entity.sql",
];
const RENAME_MIGRATION = "0273_default_wiki_company.sql";

// One workspace per case 0272 has to tell apart.
const UNTOUCHED = "ws-untouched";
const RENAMED = "ws-renamed";
const TAKEN = "ws-taken";
const FOUNDER = "user_founder";

let pglite: PGlite;

async function applyMigration(file: string) {
  const sql = await readFile(path.join(__dirname, "..", "..", "..", "drizzle", file), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    await pglite.exec(statement);
  }
}

async function defaultWiki(workspaceId: string) {
  const rows = await pglite.query<{ name: string; slug: string }>(
    `SELECT name, slug FROM goat.wikis WHERE workspace_id = $1 AND is_default`,
    [workspaceId],
  );
  return rows.rows[0];
}

beforeAll(async () => {
  pglite = await createTestPGlite({ extensions: { pg_trgm } });
  await pglite.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  await pglite.exec("CREATE SCHEMA goat;");
  await pglite.exec("CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);");
  await pglite.exec(`
    CREATE TABLE goat.workspaces (id text PRIMARY KEY, created_by_workos_id text);
    CREATE TABLE goat.workspace_members (workspace_id text, user_workos_id text, role text);
  `);
  await pglite.exec(`
    CREATE TABLE goat.wiki_sources (id text PRIMARY KEY, workspace_id text NOT NULL);
    CREATE TABLE goat.wiki_source_items (id text PRIMARY KEY, workspace_id text NOT NULL);
    CREATE TABLE goat.wiki_ingest_jobs (id text PRIMARY KEY, workspace_id text NOT NULL);
    CREATE TABLE goat.wiki_source_event_claims (id text PRIMARY KEY, workspace_id text NOT NULL);
  `);
  await pglite.exec(`
    INSERT INTO goat.users (workos_user_id) VALUES ('${FOUNDER}');
    INSERT INTO goat.workspaces (id, created_by_workos_id) VALUES
      ('${UNTOUCHED}', '${FOUNDER}'),
      ('${RENAMED}', '${FOUNDER}'),
      ('${TAKEN}', '${FOUNDER}');
  `);
  for (const migration of BASE_MIGRATIONS) await applyMigration(migration);

  // 0269 seeded each workspace a default wiki named "Wiki". Set up the two cases
  // 0272 must not touch.
  await pglite.exec(`
    UPDATE goat.wikis SET name = 'Playbook', slug = 'playbook'
    WHERE workspace_id = '${RENAMED}' AND is_default;

    INSERT INTO goat.wikis (id, workspace_id, name, slug, access, is_default, created_by_workos_id)
    VALUES ('goat_wiki_taken', '${TAKEN}', 'Company', 'company', 'workspace', false, '${FOUNDER}');
  `);

  await applyMigration(RENAME_MIGRATION);
});

describe("0273_default_wiki_company", () => {
  it("renames an untouched default wiki and moves its slug", async () => {
    expect(await defaultWiki(UNTOUCHED)).toEqual({ name: "Company", slug: "company" });
  });

  it("leaves a deliberately renamed default wiki alone", async () => {
    expect(await defaultWiki(RENAMED)).toEqual({ name: "Playbook", slug: "playbook" });
  });

  it("skips a workspace that already holds a wiki slugged company", async () => {
    // Renaming here would violate the unique index on (workspace_id, slug) and abort the
    // migration. The default wiki keeps working at its own slug.
    expect(await defaultWiki(TAKEN)).toEqual({ name: "Wiki", slug: "wiki" });
    const taken = await pglite.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM goat.wikis WHERE workspace_id = $1 AND slug = 'company'`,
      [TAKEN],
    );
    expect(taken.rows[0]?.count).toBe("1");
  });

  it("is safe to rerun", async () => {
    await applyMigration(RENAME_MIGRATION);

    expect(await defaultWiki(UNTOUCHED)).toEqual({ name: "Company", slug: "company" });
    expect(await defaultWiki(RENAMED)).toEqual({ name: "Playbook", slug: "playbook" });
    expect(await defaultWiki(TAKEN)).toEqual({ name: "Wiki", slug: "wiki" });
  });
});
