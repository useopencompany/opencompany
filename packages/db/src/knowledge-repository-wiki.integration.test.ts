// The browser page-CRUD path (KnowledgeRepository) against embedded Postgres.
//
// The case that matters here is idempotency across wikis. A wiki is part of a
// page's identity, so the same Idempotency-Key aimed at a different wiki is a
// different command. The reservation is keyed on (user, workspace, key), so
// that is reported as a conflict — the important property is that it is never
// silently replayed, which would hand the caller another wiki's page.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import type { Actor } from "@opencompany/core";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresKnowledgeRepository } from "./knowledge-repository";
import { createTestPGlite } from "./test-pglite";
import { createWiki, requireIngestionWikiId } from "./wikis";

const MIGRATIONS = [
  "0195_goat_wiki.sql",
  "0208_goat_headless_knowledge_idempotency.sql",
  "0209_goat_brain_asset_idempotency.sql",
  "0220_goat_wiki_folders.sql",
  "0269_wiki_first_class_entity.sql",
];

const WS = "ws-knowledge";
const USER = "user_founder";

let pglite: PGlite;
let repository: PostgresKnowledgeRepository;
let defaultWikiId: string;
let clevelWikiId: string;

const actor: Actor = {
  userId: USER,
  workspaceId: WS,
  role: "admin",
  permissions: ["wiki:read", "wiki:write"],
  authenticationMethod: "session",
};

beforeAll(async () => {
  pglite = await createTestPGlite({ extensions: { pg_trgm } });
  await pglite.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  await pglite.exec("CREATE SCHEMA goat;");
  await pglite.exec("CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);");
  await pglite.exec(`
    CREATE TABLE goat.workspaces (id text PRIMARY KEY, created_by_workos_id text);
    CREATE TABLE goat.workspace_members (workspace_id text, user_workos_id text, role text);
  `);
  // Not under test here; 0269 threads wiki_id through them.
  await pglite.exec(`
    CREATE TABLE goat.wiki_sources (id text PRIMARY KEY, workspace_id text NOT NULL);
    CREATE TABLE goat.wiki_source_items (id text PRIMARY KEY, workspace_id text NOT NULL);
    CREATE TABLE goat.wiki_ingest_jobs (id text PRIMARY KEY, workspace_id text NOT NULL);
    CREATE TABLE goat.wiki_source_event_claims (id text PRIMARY KEY, workspace_id text NOT NULL);
  `);
  await pglite.exec(`
    INSERT INTO goat.users (workos_user_id) VALUES ('${USER}');
    INSERT INTO goat.workspaces (id, created_by_workos_id) VALUES ('${WS}', '${USER}');
    INSERT INTO goat.workspace_members (workspace_id, user_workos_id, role)
    VALUES ('${WS}', '${USER}', 'admin');
  `);
  for (const migration of MIGRATIONS) {
    const sql = await readFile(
      path.join(__dirname, "..", "..", "..", "drizzle", migration),
      "utf8",
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      await pglite.exec(statement);
    }
  }
  const db = drizzle(pglite);
  repository = new PostgresKnowledgeRepository(db);
  defaultWikiId = await requireIngestionWikiId(WS, db);
  const clevel = await createWiki(
    { workspaceId: WS, name: "C-level", access: "restricted", createdByWorkosId: USER },
    { db },
  );
  clevelWikiId = clevel.id;
});

beforeEach(async () => {
  await pglite.exec(`
    DELETE FROM goat.knowledge_command_idempotency;
    DELETE FROM goat.wiki_links;
    DELETE FROM goat.wiki_timeline_entries;
    DELETE FROM goat.wiki_page_versions;
    DELETE FROM goat.wiki_pages;
  `);
});

const createPage = (wikiId: string, idempotencyKey: string, title = "Roadmap") =>
  repository.createWikiPage({
    actor,
    wikiId,
    idempotencyKey,
    nodeType: "page",
    parentPath: null,
    title,
  });

describe("createWikiPage", () => {
  it("replays the same key within one wiki", async () => {
    const first = await createPage(defaultWikiId, "key-1");
    const replay = await createPage(defaultWikiId, "key-1");
    expect(replay.page.id).toBe(first.page.id);
    expect(replay.transactionIds).toEqual([]);
  });

  it("refuses to replay a key across wikis instead of returning the wrong page", async () => {
    const shared = await createPage(defaultWikiId, "key-shared");

    // The wiki is part of the reserved command, so this is a different command
    // on an already-used key rather than a replay.
    await expect(createPage(clevelWikiId, "key-shared")).rejects.toMatchObject({
      code: "idempotency_conflict",
    });

    // Crucially, the other wiki did not receive the first wiki's page.
    const clevelPages = await repository.listWikiPages({ actor, wikiId: clevelWikiId });
    expect(clevelPages).toEqual([]);
    const sharedPages = await repository.listWikiPages({ actor, wikiId: defaultWikiId });
    expect(sharedPages.map((page) => page.id)).toEqual([shared.page.id]);
  });

  it("derives a distinct page id per wiki for the same key", async () => {
    const shared = await createPage(defaultWikiId, "same-key");
    await pglite.exec("DELETE FROM goat.knowledge_command_idempotency;");
    const clevel = await createPage(clevelWikiId, "same-key");

    // Without the wiki in the derived id these would collide on the primary key.
    expect(clevel.page.id).not.toBe(shared.page.id);
    expect(shared.page.path).toBe("roadmap");
    expect(clevel.page.path).toBe("roadmap");
  });

  it("rejects a key reused for a materially different command in the same wiki", async () => {
    await createPage(defaultWikiId, "key-2", "Roadmap");
    await expect(createPage(defaultWikiId, "key-2", "Something else")).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });
});

describe("addWikiTimelineEntry", () => {
  it("derives a distinct entry id per wiki for the same key", async () => {
    const shared = await createPage(defaultWikiId, "page-shared");
    const clevel = await createPage(clevelWikiId, "page-clevel");

    const first = await repository.addWikiTimelineEntry({
      actor,
      wikiId: defaultWikiId,
      idempotencyKey: "timeline-shared",
      id: shared.page.id,
      text: "Shipped",
    });
    await pglite.exec("DELETE FROM goat.knowledge_command_idempotency;");
    const second = await repository.addWikiTimelineEntry({
      actor,
      wikiId: clevelWikiId,
      idempotencyKey: "timeline-shared",
      id: clevel.page.id,
      text: "Shipped",
    });

    // Without the wiki in the derived id these would collide on the primary key.
    expect(second.entry.id).not.toBe(first.entry.id);
    expect(second.entry.pageId).toBe(clevel.page.id);
  });

  it("replays the same key within one wiki", async () => {
    const page = await createPage(defaultWikiId, "page-1");
    const first = await repository.addWikiTimelineEntry({
      actor,
      wikiId: defaultWikiId,
      idempotencyKey: "timeline-1",
      id: page.page.id,
      text: "Shipped",
    });
    const replay = await repository.addWikiTimelineEntry({
      actor,
      wikiId: defaultWikiId,
      idempotencyKey: "timeline-1",
      id: page.page.id,
      text: "Shipped",
    });
    expect(replay.entry.id).toBe(first.entry.id);
    expect(replay.transactionId).toBe(0);
  });

  it("refuses a page that lives in another wiki", async () => {
    const clevel = await createPage(clevelWikiId, "page-clevel");
    await expect(
      repository.addWikiTimelineEntry({
        actor,
        wikiId: defaultWikiId,
        idempotencyKey: "timeline-cross",
        id: clevel.page.id,
        text: "Shipped",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("updateWikiPage and deleteWikiPage", () => {
  it("cannot reach a page in another wiki", async () => {
    const clevel = await createPage(clevelWikiId, "page-clevel");

    await expect(
      repository.updateWikiPage({
        actor,
        wikiId: defaultWikiId,
        id: clevel.page.id,
        body: "# Rewritten",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      repository.deleteWikiPage({
        actor,
        wikiId: defaultWikiId,
        id: clevel.page.id,
        recursive: false,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    // The page is untouched in its own wiki.
    const pages = await repository.listWikiPages({ actor, wikiId: clevelWikiId });
    expect(pages.map((page) => page.id)).toEqual([clevel.page.id]);
  });
});
