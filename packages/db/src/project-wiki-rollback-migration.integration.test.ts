import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPGlite } from "./test-pglite";

const migrationRoot = path.resolve(import.meta.dirname, "../../..", "drizzle");

async function applyMigration(database: PGlite, filename: string) {
  const migration = await readFile(path.join(migrationRoot, filename), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
}

describe("0308 Project wiki removal", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = await createTestPGlite();
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);
      CREATE TABLE goat.workspaces (id text PRIMARY KEY);
      CREATE TABLE goat.wikis (
        id text PRIMARY KEY,
        workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
        name text NOT NULL,
        slug text NOT NULL,
        instructions text NOT NULL DEFAULT '',
        access text NOT NULL DEFAULT 'workspace',
        is_default boolean NOT NULL DEFAULT false,
        created_by_workos_id text REFERENCES goat.users(workos_user_id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX goat_wikis_workspace_slug_idx
        ON goat.wikis (workspace_id, slug);
      CREATE TABLE goat.wiki_members (
        id text PRIMARY KEY,
        wiki_id text NOT NULL REFERENCES goat.wikis(id) ON DELETE CASCADE,
        user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id) ON DELETE CASCADE,
        added_by_workos_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX goat_wiki_members_wiki_user_idx
        ON goat.wiki_members (wiki_id, user_workos_id);
      CREATE TABLE goat.wiki_pages (
        id text PRIMARY KEY,
        wiki_id text NOT NULL REFERENCES goat.wikis(id) ON DELETE CASCADE,
        body text NOT NULL DEFAULT ''
      );
      CREATE TABLE goat.projects (
        id text PRIMARY KEY,
        user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id) ON DELETE CASCADE,
        workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO goat.users (workos_user_id) VALUES ('user_1');
      INSERT INTO goat.workspaces (id) VALUES ('workspace_1');
      INSERT INTO goat.wikis (
        id, workspace_id, name, slug, access, is_default, created_by_workos_id
      ) VALUES
        ('wiki_company', 'workspace_1', 'Company', 'company', 'workspace', true, 'user_1'),
        ('wiki_project_unattached', 'workspace_1', 'Manual', 'manual', 'restricted', false, 'user_1');
      INSERT INTO goat.projects (id, user_workos_id, workspace_id, name) VALUES
        ('project_1', 'user_1', 'workspace_1', 'Launch'),
        ('project_2', 'user_1', 'workspace_1', 'Research');
      INSERT INTO goat.wiki_pages (id, wiki_id, body) VALUES
        ('page_company', 'wiki_company', 'Keep company knowledge'),
        ('page_manual', 'wiki_project_unattached', 'Keep manual knowledge');
    `);

    await applyMigration(database, "0307_project_wikis.sql");
    await database.exec(`
      INSERT INTO goat.wiki_pages (id, wiki_id, body)
      SELECT 'page_project', wiki_id, 'Remove Project knowledge'
      FROM goat.projects
      WHERE id = 'project_1';
    `);
    await applyMigration(database, "0308_remove_project_wikis.sql");
  });

  afterEach(async () => database.close());

  it("removes attached wikis and their content while preserving Projects and independent wikis", async () => {
    const projects = await database.query<{ id: string }>(
      "SELECT id FROM goat.projects ORDER BY id",
    );
    const wikis = await database.query<{ id: string }>("SELECT id FROM goat.wikis ORDER BY id");
    const pages = await database.query<{ id: string }>(
      "SELECT id FROM goat.wiki_pages ORDER BY id",
    );

    expect(projects.rows).toEqual([{ id: "project_1" }, { id: "project_2" }]);
    expect(wikis.rows).toEqual([{ id: "wiki_company" }, { id: "wiki_project_unattached" }]);
    expect(pages.rows).toEqual([{ id: "page_company" }, { id: "page_manual" }]);
  });

  it("drops the Project wiki column and its index", async () => {
    const columns = await database.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'wiki_id'
    `);
    const indexes = await database.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE indexname = 'opencompany_projects_wiki_idx'
    `);

    expect(columns.rows).toEqual([]);
    expect(indexes.rows).toEqual([]);
  });
});
