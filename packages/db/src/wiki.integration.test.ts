// Integration tests for the wiki storage layer against embedded Postgres
// (PGlite) running the real wiki migrations — FTS, trigram, generated columns,
// and check constraints all behave like production. Page identity is
// (wiki_id, path), so every call is scoped to a resolved wiki.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPGlite } from "./test-pglite";
import {
  addWikiTimelineEntry,
  createWikiFolder,
  deleteWikiPage,
  getWikiBacklinks,
  getWikiTree,
  grepWiki,
  listWikiTimeline,
  moveWikiNode,
  recentWikiChanges,
  renameWikiNode,
  resolveWikiPages,
  searchWiki,
  WikiError,
  writeWikiPage,
} from "./wiki";

const WS = "ws-test";
const MIGRATIONS = [
  "0195_goat_wiki.sql",
  "0220_goat_wiki_folders.sql",
  "0269_wiki_first_class_entity.sql",
];

// The default wiki the migration seeds for each workspace, plus a second wiki in
// the same workspace: two independent path namespaces under one tenant.
const SCOPE = { workspaceId: WS, wikiId: `goat_wiki_default_${WS}` };
const SECOND_SCOPE = { workspaceId: WS, wikiId: "goat_wiki_second" };
const OTHER_SCOPE = { workspaceId: "ws-other", wikiId: "goat_wiki_default_ws-other" };

let pglite: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  pglite = await createTestPGlite({ extensions: { pg_trgm } });
  await pglite.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  await pglite.exec("CREATE SCHEMA goat;");
  await pglite.exec(
    "CREATE TABLE goat.workspaces (id text PRIMARY KEY, created_by_workos_id text);",
  );
  await pglite.exec("CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);");
  // 0269 threads wiki_id through the ingestion tables too. They are not under
  // test here, so stub them with just the columns that migration touches.
  await pglite.exec(`
    CREATE TABLE goat.wiki_sources (id text PRIMARY KEY, workspace_id text NOT NULL);
    CREATE TABLE goat.wiki_source_items (id text PRIMARY KEY, workspace_id text NOT NULL);
    CREATE TABLE goat.wiki_ingest_jobs (id text PRIMARY KEY, workspace_id text NOT NULL);
    CREATE TABLE goat.wiki_source_event_claims (id text PRIMARY KEY, workspace_id text NOT NULL);
  `);
  await pglite.exec(`INSERT INTO goat.workspaces (id) VALUES ('${WS}'), ('ws-other');`);
  for (const migration of MIGRATIONS) {
    const sql = await readFile(
      path.join(__dirname, "..", "..", "..", "drizzle", migration),
      "utf8",
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      await pglite.exec(statement);
    }
  }
  await pglite.exec(
    `INSERT INTO goat.wikis (id, workspace_id, name, slug, access, is_default)
     VALUES ('${SECOND_SCOPE.wikiId}', '${WS}', 'C-level', 'c-level', 'restricted', false);`,
  );
  db = drizzle(pglite);
});

beforeEach(async () => {
  await pglite.exec(
    "DELETE FROM goat.wiki_links; DELETE FROM goat.wiki_timeline_entries; DELETE FROM goat.wiki_page_versions; DELETE FROM goat.wiki_pages;",
  );
});

describe("writeWikiPage", () => {
  it("creates pages, derives titles, and records a version", async () => {
    const result = await writeWikiPage(
      { scope: SCOPE, path: "projects", body: "# Projects\n\nAll projects.", kind: "other" },
      db,
    );
    expect(result.action).toBe("created");
    expect(result.page.slug).toBe("projects");
    expect(result.page.title).toBe("Projects");
    const changes = await recentWikiChanges(SCOPE, { since: new Date(Date.now() - 60_000) }, db);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ slug: "projects", writes: 1, addedLines: 3 });
  });

  it("auto-creates missing ancestors as folders", async () => {
    const result = await writeWikiPage(
      { scope: SCOPE, path: "projects/site/notes", body: "# Notes", kind: "research" },
      db,
    );
    expect(result.createdAncestors).toEqual(["projects", "projects/site"]);
    const tree = await getWikiTree(SCOPE, db);
    expect(tree.map((entry) => entry.path)).toEqual([
      "projects",
      "projects/site",
      "projects/site/notes",
    ]);
    expect(tree.map((entry) => entry.nodeType)).toEqual(["folder", "folder", "page"]);
    expect(tree[1]?.childCount).toBe(1);
  });

  it("normalizes whitespace and surrounding slashes without a regular expression", async () => {
    const result = await writeWikiPage(
      { scope: SCOPE, path: "  ///projects/site///  ", body: "# Site" },
      db,
    );
    expect(result.page.path).toBe("projects/site");
    expect(result.createdAncestors).toEqual(["projects"]);
  });

  it("honors an explicit title and preserves it across body rewrites", async () => {
    await writeWikiPage(
      { scope: SCOPE, path: "q3-planning", body: "goals go here", title: "Q3 Planning" },
      db,
    );
    let { pages } = await resolveWikiPages(SCOPE, ["q3-planning"], db);
    expect(pages[0]?.title).toBe("Q3 Planning");
    // An agent rewrite without an H1 keeps the human-set name...
    await writeWikiPage({ scope: SCOPE, path: "q3-planning", body: "updated goals" }, db);
    ({ pages } = await resolveWikiPages(SCOPE, ["q3-planning"], db));
    expect(pages[0]?.title).toBe("Q3 Planning");
    // ...while a body with an H1 still wins when no explicit title is given.
    await writeWikiPage({ scope: SCOPE, path: "q3-planning", body: "# Q3 Plan v2" }, db);
    ({ pages } = await resolveWikiPages(SCOPE, ["q3-planning"], db));
    expect(pages[0]?.title).toBe("Q3 Plan v2");
  });

  it("honors an explicit empty title on create and clear (Notion-style Untitled)", async () => {
    // The UI creates pages with an empty name; nothing may auto-fill it.
    await writeWikiPage({ scope: SCOPE, path: "fresh-page", body: "", title: "" }, db);
    let { pages } = await resolveWikiPages(SCOPE, ["fresh-page"], db);
    expect(pages[0]?.title).toBe("");
    // Clearing an existing name sticks, even when the body has an H1.
    await writeWikiPage({ scope: SCOPE, path: "fresh-page", body: "# Heading", title: "" }, db);
    ({ pages } = await resolveWikiPages(SCOPE, ["fresh-page"], db));
    expect(pages[0]?.title).toBe("");
  });

  it("updates in place and reports unchanged writes", async () => {
    await writeWikiPage({ scope: SCOPE, path: "notes", body: "a\nb" }, db);
    const updated = await writeWikiPage({ scope: SCOPE, path: "notes", body: "a\nb\nc" }, db);
    expect(updated.action).toBe("updated");
    const unchanged = await writeWikiPage({ scope: SCOPE, path: "notes", body: "a\nb\nc" }, db);
    expect(unchanged.action).toBe("unchanged");
  });

  it("absorbs concurrent creation of a shared ancestor folder", async () => {
    // Parallel agent tool calls race check-then-insert on the same missing
    // parent; every write must converge instead of failing with "already exists".
    const results = await Promise.all([
      writeWikiPage({ scope: SCOPE, path: "company/pitch", body: "# Pitch" }, db),
      writeWikiPage({ scope: SCOPE, path: "company/team", body: "# Team" }, db),
      writeWikiPage({ scope: SCOPE, path: "company/history", body: "# History" }, db),
      createWikiFolder({ scope: SCOPE, path: "company" }, db),
      createWikiFolder({ scope: SCOPE, path: "company" }, db),
    ]);
    expect(results.slice(0, 3).map((result) => result.action)).toEqual([
      "created",
      "created",
      "created",
    ]);
    const tree = await getWikiTree(SCOPE, db);
    expect(tree.filter((entry) => entry.path === "company")).toHaveLength(1);
    expect(tree.map((entry) => entry.path).sort()).toEqual([
      "company",
      "company/history",
      "company/pitch",
      "company/team",
    ]);
  });

  it("allows a slug to be reused under a different folder", async () => {
    await writeWikiPage({ scope: SCOPE, path: "projects/site", body: "" }, db);
    const result = await writeWikiPage({ scope: SCOPE, path: "archive/site", body: "" }, db);
    expect(result.action).toBe("created");
  });

  it("keeps slugs independent across workspaces", async () => {
    await writeWikiPage({ scope: SCOPE, path: "notes", body: "mine" }, db);
    const other = await writeWikiPage({ scope: OTHER_SCOPE, path: "notes", body: "theirs" }, db);
    expect(other.action).toBe("created");
  });

  it("lets two wikis in one workspace hold the same path independently", async () => {
    await writeWikiPage({ scope: SCOPE, path: "projects/roadmap", body: "shared roadmap" }, db);
    const second = await writeWikiPage(
      { scope: SECOND_SCOPE, path: "projects/roadmap", body: "board roadmap" },
      db,
    );
    expect(second.action).toBe("created");

    const shared = await resolveWikiPages(SCOPE, ["projects/roadmap"], db);
    const board = await resolveWikiPages(SECOND_SCOPE, ["projects/roadmap"], db);
    expect(shared.pages[0]?.content).toBe("shared roadmap");
    expect(board.pages[0]?.content).toBe("board roadmap");
  });

  it("rebuilds the derived link index on every write", async () => {
    await writeWikiPage({ scope: SCOPE, path: "target-page", body: "# Target" }, db);
    await writeWikiPage(
      {
        scope: SCOPE,
        path: "from-page",
        body: "Links to [[target-page]] and [[source:linear:issue:ENG-9]].",
      },
      db,
    );
    expect(await getWikiBacklinks(SCOPE, "target-page", db)).toMatchObject([{ slug: "from-page" }]);
    await writeWikiPage({ scope: SCOPE, path: "from-page", body: "No more links." }, db);
    expect(await getWikiBacklinks(SCOPE, "target-page", db)).toEqual([]);
  });
});

// Every retrieval surface has to stop at the wiki boundary, or a page title from
// a restricted wiki leaks to a non-member through search, grep, or a [[link]].
describe("wiki isolation", () => {
  beforeEach(async () => {
    await writeWikiPage(
      { scope: SECOND_SCOPE, path: "board/acquisition-offer", body: "# Acquisition offer" },
      db,
    );
  });

  it("never resolves a bare basename into another wiki", async () => {
    const { pages, missing } = await resolveWikiPages(SCOPE, ["acquisition-offer"], db);
    expect(pages).toEqual([]);
    expect(missing).toEqual(["acquisition-offer"]);
  });

  it("keeps tree, search, grep, and recent inside the wiki", async () => {
    await writeWikiPage({ scope: SCOPE, path: "handbook", body: "# Handbook" }, db);

    expect((await getWikiTree(SCOPE, db)).map((entry) => entry.path)).toEqual(["handbook"]);
    expect(await searchWiki(SCOPE, { text: "acquisition" }, db)).toEqual([]);
    expect(await grepWiki(SCOPE, { pattern: "Acquisition" }, db)).toEqual([]);
    expect(
      (await recentWikiChanges(SCOPE, { since: new Date(Date.now() - 60_000) }, db)).map(
        (change) => change.path,
      ),
    ).toEqual(["handbook"]);

    // The same calls against the other wiki do see its page.
    expect(await searchWiki(SECOND_SCOPE, { text: "acquisition" }, db)).toHaveLength(1);
  });

  it("never resolves a [[link]] or backlink across the boundary", async () => {
    // `wiki_links.target` is a plain path string, so an identically named page in
    // another wiki would otherwise match.
    await writeWikiPage(
      { scope: SCOPE, path: "board/acquisition-offer", body: "# Public note" },
      db,
    );
    await writeWikiPage(
      { scope: SCOPE, path: "referrer", body: "See [[board/acquisition-offer]]." },
      db,
    );

    expect(await getWikiBacklinks(SCOPE, "board/acquisition-offer", db)).toMatchObject([
      { path: "referrer" },
    ]);
    expect(await getWikiBacklinks(SECOND_SCOPE, "board/acquisition-offer", db)).toEqual([]);
  });

  it("refuses to read, move, or delete a node that lives in another wiki", async () => {
    await expect(
      listWikiTimeline({ scope: SCOPE, path: "board/acquisition-offer" }, db),
    ).rejects.toBeInstanceOf(WikiError);
    await expect(
      moveWikiNode({ scope: SCOPE, path: "board/acquisition-offer", newParentPath: null }, db),
    ).rejects.toBeInstanceOf(WikiError);
    await expect(
      deleteWikiPage({ scope: SCOPE, path: "board/acquisition-offer" }, db),
    ).rejects.toBeInstanceOf(WikiError);
  });
});

describe("resolveWikiPages", () => {
  it("resolves exact paths and unique basenames", async () => {
    await writeWikiPage({ scope: SCOPE, path: "projects/site", body: "# Site" }, db);
    const { pages, missing } = await resolveWikiPages(
      SCOPE,
      ["site", "projects/site", "ghost"],
      db,
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]?.slug).toBe("site");
    expect(missing).toEqual(["ghost"]);
  });

  it("does not resolve ambiguous or missing basenames", async () => {
    await writeWikiPage({ scope: SCOPE, path: "projects/goals", body: "work" }, db);
    await writeWikiPage({ scope: SCOPE, path: "personal/goals", body: "life" }, db);
    const { pages, missing } = await resolveWikiPages(
      SCOPE,
      ["goals", "projects/goals", "ghost"],
      db,
    );
    expect(pages.map((page) => page.path)).toEqual(["projects/goals"]);
    expect(missing).toEqual(["goals", "ghost"]);
  });
});

describe("moveWikiNode", () => {
  it("moves a folder subtree and rewrites page and timeline links", async () => {
    await createWikiFolder({ scope: SCOPE, path: "projects/site" }, db);
    await writeWikiPage({ scope: SCOPE, path: "projects/site/notes", body: "n" }, db);
    await createWikiFolder({ scope: SCOPE, path: "archive" }, db);
    await writeWikiPage(
      { scope: SCOPE, path: "referrer", body: "See [[projects/site/notes|Notes]]." },
      db,
    );
    await addWikiTimelineEntry(
      {
        scope: SCOPE,
        path: "referrer",
        at: new Date("2026-08-01T10:00:00Z"),
        text: "Reviewed [[projects/site/notes]]",
      },
      db,
    );
    const result = await moveWikiNode(
      { scope: SCOPE, path: "projects/site", newParentPath: "archive" },
      db,
    );
    expect(result.movedDescendants).toBe(1);
    expect(result.rewrittenReferrers).toEqual(["referrer"]);
    expect(result.txids).toHaveLength(3);
    const tree = await getWikiTree(SCOPE, db);
    expect(tree.map((entry) => entry.path).sort()).toEqual([
      "archive",
      "archive/site",
      "archive/site/notes",
      "projects",
      "referrer",
    ]);
    const referrer = (await resolveWikiPages(SCOPE, ["referrer"], db)).pages[0];
    expect(referrer?.content).toBe("See [[archive/site/notes|Notes]].");
    const timeline = await listWikiTimeline({ scope: SCOPE, path: "referrer" }, db);
    expect(timeline[0]?.text).toBe("Reviewed [[archive/site/notes]]");
  });

  it("refuses cycles and missing parents", async () => {
    await createWikiFolder({ scope: SCOPE, path: "a/b" }, db);
    await expect(
      moveWikiNode({ scope: SCOPE, path: "a", newParentPath: "a/b" }, db),
    ).rejects.toThrow(/inside its own subtree/);
    await expect(
      moveWikiNode({ scope: SCOPE, path: "a/b", newParentPath: "ghost" }, db),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("renameWikiNode", () => {
  it("renames the slug and rewrites backlinks in the same transaction", async () => {
    const created = await writeWikiPage(
      { scope: SCOPE, path: "untitled", body: "Self: [[untitled]]", title: "" },
      db,
    );
    await writeWikiPage({ scope: SCOPE, path: "referrer", body: "See [[untitled]]." }, db);

    const result = await renameWikiNode(
      {
        scope: SCOPE,
        id: created.page.id,
        title: "Launch Plan",
        slug: "launch-plan",
      },
      db,
    );

    expect(result.node).toMatchObject({
      slug: "launch-plan",
      path: "launch-plan",
      title: "Launch Plan",
      content: "Self: [[launch-plan]]",
    });
    expect(result.txids).toHaveLength(4);
    const referrer = (await resolveWikiPages(SCOPE, ["referrer"], db)).pages[0];
    expect(referrer?.content).toBe("See [[launch-plan]].");
    await expect(resolveWikiPages(SCOPE, ["untitled"], db)).resolves.toMatchObject({
      missing: ["untitled"],
    });
  });

  it("rejects a sibling slug collision without changing the title", async () => {
    const created = await writeWikiPage(
      { scope: SCOPE, path: "untitled", body: "", title: "" },
      db,
    );
    await writeWikiPage({ scope: SCOPE, path: "launch-plan", body: "" }, db);

    await expect(
      renameWikiNode(
        {
          scope: SCOPE,
          id: created.page.id,
          title: "Launch Plan",
          slug: "launch-plan",
        },
        db,
      ),
    ).rejects.toThrow(/already exists/);
    const original = (await resolveWikiPages(SCOPE, ["untitled"], db)).pages[0];
    expect(original?.title).toBe("");
  });
});

describe("deleteWikiPage", () => {
  it("requires recursive for subtrees and versions every deletion", async () => {
    await writeWikiPage({ scope: SCOPE, path: "projects/site", body: "x" }, db);
    await expect(deleteWikiPage({ scope: SCOPE, path: "projects" }, db)).rejects.toThrow(WikiError);
    const result = await deleteWikiPage({ scope: SCOPE, path: "projects", recursive: true }, db);
    expect(result.deletedPaths).toEqual(["projects/site", "projects"]);
    const changes = await recentWikiChanges(SCOPE, { since: new Date(Date.now() - 60_000) }, db);
    expect(changes.filter((change) => change.deleted)).toHaveLength(2);
    expect(await getWikiTree(SCOPE, db)).toEqual([]);
  });
});

describe("retrieval", () => {
  beforeEach(async () => {
    await writeWikiPage(
      {
        scope: SCOPE,
        path: "projects/website-redesign",
        body: "# Website Redesign\n\nRelaunch the marketing site with the agency.",
        kind: "project",
      },
      db,
    );
    await writeWikiPage(
      {
        scope: SCOPE,
        path: "people/ada-lovelace",
        body: "# Ada Lovelace\n\nFounding engineer, leads the platform work.",
        kind: "person",
      },
      db,
    );
  });

  it("searches lexically with typo-tolerant title matching", async () => {
    const hits = await searchWiki(SCOPE, { text: "marketing relaunch" }, db);
    expect(hits[0]?.slug).toBe("website-redesign");
    const typo = await searchWiki(SCOPE, { text: "Ada Lovelase" }, db);
    expect(typo.some((hit) => hit.slug === "ada-lovelace")).toBe(true);
  });

  it("greps with line numbers", async () => {
    const matches = await grepWiki(SCOPE, { pattern: "founding engineer", ignoreCase: true }, db);
    expect(matches).toMatchObject([{ slug: "ada-lovelace", lineNumber: 3 }]);
  });

  it("greps titles that never appear in the body as pseudo-line 0", async () => {
    await writeWikiPage(
      { scope: SCOPE, path: "q3-okrs", body: "Ship the relaunch.", title: "Q3 OKRs" },
      db,
    );
    const matches = await grepWiki(SCOPE, { pattern: "okr", ignoreCase: true }, db);
    expect(matches).toMatchObject([{ slug: "q3-okrs", lineNumber: 0, line: "Q3 OKRs" }]);
    // A title derived from the body's H1 matches once, via the body line.
    const h1 = await grepWiki(SCOPE, { pattern: "ada lovelace", ignoreCase: true }, db);
    expect(h1).toMatchObject([{ slug: "ada-lovelace", lineNumber: 1 }]);
  });

  it("scopes retrieval to the workspace", async () => {
    expect(await searchWiki(OTHER_SCOPE, { text: "marketing relaunch" }, db)).toEqual([]);
    expect(await grepWiki(OTHER_SCOPE, { pattern: "engineer", ignoreCase: true }, db)).toEqual([]);
  });
});

describe("timeline", () => {
  it("adds and lists entries separately from the body", async () => {
    await writeWikiPage({ scope: SCOPE, path: "projects/site", body: "# Site" }, db);
    await addWikiTimelineEntry(
      {
        scope: SCOPE,
        path: "projects/site",
        at: new Date("2026-08-01T10:00:00Z"),
        text: "Kickoff call [[source:jamie:meeting:xyz]]",
      },
      db,
    );
    await addWikiTimelineEntry(
      {
        scope: SCOPE,
        path: "projects/site",
        at: new Date("2026-08-05T10:00:00Z"),
        text: "Budget approved",
      },
      db,
    );
    const entries = await listWikiTimeline({ scope: SCOPE, path: "projects/site" }, db);
    expect(entries.map((entry) => entry.text)).toEqual([
      "Budget approved",
      "Kickoff call [[source:jamie:meeting:xyz]]",
    ]);
    const since = await listWikiTimeline(
      { scope: SCOPE, path: "projects/site", since: new Date("2026-08-03T00:00:00Z") },
      db,
    );
    expect(since).toHaveLength(1);
  });
});

describe("recentWikiChanges", () => {
  it("aggregates writes per page with line deltas", async () => {
    await writeWikiPage({ scope: SCOPE, path: "notes", body: "a\nb" }, db);
    await writeWikiPage({ scope: SCOPE, path: "notes", body: "a\nb\nc\nd" }, db);
    await writeWikiPage({ scope: SCOPE, path: "notes", body: "a\nb\nc" }, db);
    const changes = await recentWikiChanges(SCOPE, { since: new Date(Date.now() - 60_000) }, db);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ slug: "notes", writes: 3, addedLines: 4, removedLines: 1 });
  });
});
