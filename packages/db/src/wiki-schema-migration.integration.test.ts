import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { describe, expect, it } from "vitest";

const migrationsRoot = path.join(__dirname, "..", "..", "..", "drizzle");

async function applyMigration(db: PGlite, name: string) {
  const migration = await readFile(path.join(migrationsRoot, name), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    await db.exec(statement);
  }
}

describe("0220_goat_wiki_folders", () => {
  it("converts stub parents and splits parent pages with bodies", async () => {
    const db = new PGlite({ extensions: { pg_trgm } });
    await db.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    await db.exec("CREATE SCHEMA goat;");
    await db.exec("CREATE TABLE goat.workspaces (id text PRIMARY KEY);");
    await db.exec("CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);");
    await applyMigration(db, "0195_goat_wiki.sql");
    await db.exec("INSERT INTO goat.workspaces (id) VALUES ('ws');");
    await db.exec(`
      INSERT INTO goat.wiki_pages
        (id, workspace_id, slug, path, title, content, content_hash, size_bytes)
      VALUES
        ('stub', 'ws', 'projects', 'projects', 'Projects', '', '${"0".repeat(64)}', 0),
        ('stub-child', 'ws', 'site', 'projects/site', 'Site', 'Site body', '${"1".repeat(64)}', 9),
        ('parent-page', 'ws', 'section', 'section', 'Section', 'Parent body', '${"2".repeat(64)}', 11),
        ('parent-child', 'ws', 'child', 'section/child', 'Child', 'Child body', '${"3".repeat(64)}', 10);
      INSERT INTO goat.wiki_timeline_entries (id, workspace_id, page_id, at, text)
      VALUES ('timeline', 'ws', 'parent-page', now(), 'Parent event');
      INSERT INTO goat.wiki_page_versions
        (id, workspace_id, page_id, slug, path, title, kind, content, content_hash, operation)
      VALUES
        ('version', 'ws', 'parent-page', 'section', 'section', 'Section', 'other',
         'Parent body', '${"2".repeat(64)}', 'write');
    `);

    await applyMigration(db, "0220_goat_wiki_folders.sql");

    const result = await db.query<{
      id: string;
      path: string;
      node_type: string;
      content: string;
    }>("SELECT id, path, node_type, content FROM goat.wiki_pages ORDER BY path");
    expect(result.rows).toMatchObject([
      { path: "projects", node_type: "folder", content: "" },
      { path: "projects/site", node_type: "page", content: "Site body" },
      { id: "parent-page", path: "section", node_type: "folder", content: "" },
      { path: "section/child", node_type: "page", content: "Child body" },
      { path: "section/section", node_type: "page", content: "Parent body" },
    ]);

    const timeline = await db.query<{ page_id: string; path: string }>(`
      SELECT timeline.page_id, page.path
      FROM goat.wiki_timeline_entries timeline
      JOIN goat.wiki_pages page ON page.id = timeline.page_id
      WHERE timeline.id = 'timeline'
    `);
    expect(timeline.rows[0]?.path).toBe("section/section");

    const version = await db.query<{ page_id: string; path: string }>(`
      SELECT version.page_id, page.path
      FROM goat.wiki_page_versions version
      JOIN goat.wiki_pages page ON page.id = version.page_id
      WHERE version.id = 'version'
    `);
    expect(version.rows[0]?.path).toBe("section/section");

    const migrationVersion = await db.query<{ page_id: string; path: string }>(`
      SELECT version.page_id, version.path
      FROM goat.wiki_page_versions version
      JOIN goat.wiki_pages page ON page.id = version.page_id
      WHERE page.path = 'section/section' AND version.operation = 'move'
    `);
    expect(migrationVersion.rows[0]?.path).toBe("section/section");

    await expect(
      db.exec(`
        INSERT INTO goat.wiki_pages
          (id, workspace_id, slug, path, title, content, content_hash, size_bytes)
        VALUES ('same-basename', 'ws', 'child', 'elsewhere/child', 'Child', '', '${"4".repeat(64)}', 0)
      `),
    ).resolves.toBeDefined();
  });
});
