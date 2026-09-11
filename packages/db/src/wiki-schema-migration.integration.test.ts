import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { describe, expect, it } from "vitest";
import { createTestPGlite } from "./test-pglite";

const migrationsRoot = path.join(__dirname, "..", "..", "..", "drizzle");

async function applyMigration(db: PGlite, name: string) {
  const migration = await readFile(path.join(migrationsRoot, name), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    await db.exec(statement);
  }
}

describe("0220_goat_wiki_folders", () => {
  it("converts stub parents and splits parent pages with bodies", async () => {
    const db = await createTestPGlite({ extensions: { pg_trgm } });
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

describe("0269_wiki_first_class_entity", () => {
  it("seeds one default wiki per workspace and attaches every existing row to it", async () => {
    const db = await createTestPGlite({ extensions: { pg_trgm } });
    await db.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    await db.exec("CREATE SCHEMA goat;");
    await db.exec("CREATE TABLE goat.workspaces (id text PRIMARY KEY, created_by_workos_id text);");
    await db.exec("CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);");
    await db.exec(`
      CREATE TABLE goat.wiki_sources (id text PRIMARY KEY, workspace_id text NOT NULL);
      CREATE TABLE goat.wiki_source_items (id text PRIMARY KEY, workspace_id text NOT NULL);
      CREATE TABLE goat.wiki_ingest_jobs (id text PRIMARY KEY, workspace_id text NOT NULL);
      CREATE TABLE goat.wiki_source_event_claims (id text PRIMARY KEY, workspace_id text NOT NULL);
    `);
    await applyMigration(db, "0195_goat_wiki.sql");
    await applyMigration(db, "0220_goat_wiki_folders.sql");
    await db.exec(`
      INSERT INTO goat.users (workos_user_id) VALUES ('user_1');
      INSERT INTO goat.workspaces (id, created_by_workos_id)
      VALUES ('ws-a', 'user_1'), ('ws-b', 'user_1');
      INSERT INTO goat.wiki_pages
        (id, workspace_id, slug, path, title, content, content_hash, size_bytes)
      VALUES
        ('page-a', 'ws-a', 'roadmap', 'roadmap', 'Roadmap', 'A body', '${"a".repeat(64)}', 6),
        ('page-b', 'ws-b', 'roadmap', 'roadmap', 'Roadmap', 'B body', '${"b".repeat(64)}', 6);
      INSERT INTO goat.wiki_page_versions
        (id, workspace_id, page_id, slug, path, title, kind, content, content_hash, operation)
      VALUES ('version-a', 'ws-a', 'page-a', 'roadmap', 'roadmap', 'Roadmap', 'other',
              'A body', '${"a".repeat(64)}', 'write');
      INSERT INTO goat.wiki_timeline_entries (id, workspace_id, page_id, at, text)
      VALUES ('timeline-a', 'ws-a', 'page-a', now(), 'Shipped');
      INSERT INTO goat.wiki_links (workspace_id, from_page_id, kind, target)
      VALUES ('ws-a', 'page-a', 'page', 'somewhere');
      INSERT INTO goat.wiki_sources (id, workspace_id) VALUES ('source-a', 'ws-a');
    `);

    await applyMigration(db, "0269_wiki_first_class_entity.sql");

    const wikis = await db.query<{ workspace_id: string; slug: string; is_default: boolean }>(
      "SELECT workspace_id, slug, is_default FROM goat.wikis ORDER BY workspace_id",
    );
    expect(wikis.rows).toMatchObject([
      { workspace_id: "ws-a", slug: "wiki", is_default: true },
      { workspace_id: "ws-b", slug: "wiki", is_default: true },
    ]);

    // Every pre-existing row now belongs to its workspace's default wiki.
    const attached = await db.query<{ table_name: string; wiki_id: string }>(`
      SELECT 'wiki_pages' AS table_name, wiki_id FROM goat.wiki_pages WHERE id = 'page-a'
      UNION ALL
      SELECT 'wiki_page_versions', wiki_id FROM goat.wiki_page_versions WHERE id = 'version-a'
      UNION ALL
      SELECT 'wiki_timeline_entries', wiki_id FROM goat.wiki_timeline_entries WHERE id = 'timeline-a'
      UNION ALL
      SELECT 'wiki_sources', wiki_id FROM goat.wiki_sources WHERE id = 'source-a'
      UNION ALL
      SELECT 'wiki_links', wiki_id FROM goat.wiki_links WHERE from_page_id = 'page-a'
    `);
    expect(attached.rows).toHaveLength(5);
    for (const row of attached.rows) {
      expect(row.wiki_id).toBe("goat_wiki_default_ws-a");
    }

    // Page identity is (wiki_id, path): a second wiki may reuse the same path,
    // and the same wiki still may not.
    await db.exec(`
      INSERT INTO goat.wikis (id, workspace_id, name, slug, access, is_default)
      VALUES ('goat_wiki_second', 'ws-a', 'C-level', 'c-level', 'restricted', false);
    `);
    await expect(
      db.exec(`
        INSERT INTO goat.wiki_pages
          (id, workspace_id, wiki_id, slug, path, title, content, content_hash, size_bytes)
        VALUES ('page-second', 'ws-a', 'goat_wiki_second', 'roadmap', 'roadmap', 'Roadmap', '',
                '${"c".repeat(64)}', 0)
      `),
    ).resolves.toBeDefined();
    await expect(
      db.exec(`
        INSERT INTO goat.wiki_pages
          (id, workspace_id, wiki_id, slug, path, title, content, content_hash, size_bytes)
        VALUES ('page-dupe', 'ws-a', 'goat_wiki_default_ws-a', 'roadmap', 'roadmap', 'Roadmap', '',
                '${"d".repeat(64)}', 0)
      `),
    ).rejects.toThrow();

    // Exactly one default wiki per workspace.
    await expect(
      db.exec(`
        INSERT INTO goat.wikis (id, workspace_id, name, slug, access, is_default)
        VALUES ('goat_wiki_third', 'ws-a', 'Second default', 'second-default', 'workspace', true)
      `),
    ).rejects.toThrow();
  });
});
