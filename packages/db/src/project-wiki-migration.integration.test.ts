import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPGlite } from "./test-pglite";

const migrationPath = path.resolve(
  import.meta.dirname,
  "../../..",
  "drizzle/0307_project_wikis.sql",
);

describe("0307 Project wikis", () => {
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
      INSERT INTO goat.projects (id, user_workos_id, workspace_id, name) VALUES
        ('project_1', 'user_1', 'workspace_1', 'Launch'),
        ('project_2', 'user_1', 'workspace_1', 'Launch');
    `);

    const migration = await readFile(migrationPath, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  });

  afterEach(async () => database.close());

  it("backfills one private wiki and owner membership per existing Project", async () => {
    const rows = await database.query<{
      project_id: string;
      wiki_id: string;
      slug: string;
      access: string;
      member_id: string;
    }>(`
      SELECT
        project.id AS project_id,
        wiki.id AS wiki_id,
        wiki.slug,
        wiki.access,
        member.user_workos_id AS member_id
      FROM goat.projects project
      JOIN goat.wikis wiki ON wiki.id = project.wiki_id
      JOIN goat.wiki_members member ON member.wiki_id = wiki.id
      ORDER BY project.id
    `);

    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((row) => row.project_id)).toEqual(["project_1", "project_2"]);
    expect(new Set(rows.rows.map((row) => row.wiki_id))).toHaveProperty("size", 2);
    expect(new Set(rows.rows.map((row) => row.slug))).toHaveProperty("size", 2);
    expect(
      rows.rows.every((row) => row.access === "restricted" && row.member_id === "user_1"),
    ).toBe(true);
  });

  it("keeps the Project when its wiki is removed", async () => {
    await database.exec(`
      DELETE FROM goat.wikis
      WHERE id = (SELECT wiki_id FROM goat.projects WHERE id = 'project_1')
    `);
    const project = await database.query<{ wiki_id: string | null }>(
      "SELECT wiki_id FROM goat.projects WHERE id = 'project_1'",
    );
    expect(project.rows).toEqual([{ wiki_id: null }]);
  });
});
