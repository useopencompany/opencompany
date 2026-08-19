// Integration tests for the wiki storage layer against embedded Postgres
// (PGlite) running the real 0195_goat_wiki.sql migration — FTS, trigram,
// generated columns, and check constraints all behave like production.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  resolveWikiPages,
  searchWiki,
  WikiError,
  writeWikiPage,
} from "./wiki";

const WS = "ws-test";
const MIGRATIONS = ["0195_goat_wiki.sql", "0217_goat_wiki_folders.sql"];

let pglite: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  pglite = new PGlite({ extensions: { pg_trgm } });
  await pglite.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  await pglite.exec("CREATE SCHEMA goat;");
  await pglite.exec("CREATE TABLE goat.workspaces (id text PRIMARY KEY);");
  await pglite.exec("CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);");
  for (const migration of MIGRATIONS) {
    const sql = await readFile(
      path.join(__dirname, "..", "..", "..", "drizzle", migration),
      "utf8",
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      await pglite.exec(statement);
    }
  }
  await pglite.exec(`INSERT INTO goat.workspaces (id) VALUES ('${WS}'), ('ws-other');`);
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
      { workspaceId: WS, path: "projects", body: "# Projects\n\nAll projects.", kind: "other" },
      db,
    );
    expect(result.action).toBe("created");
    expect(result.page.slug).toBe("projects");
    expect(result.page.title).toBe("Projects");
    const changes = await recentWikiChanges(WS, { since: new Date(Date.now() - 60_000) }, db);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ slug: "projects", writes: 1, addedLines: 3 });
  });

  it("auto-creates missing ancestors as folders", async () => {
    const result = await writeWikiPage(
      { workspaceId: WS, path: "projects/site/notes", body: "# Notes", kind: "research" },
      db,
    );
    expect(result.createdAncestors).toEqual(["projects", "projects/site"]);
    const tree = await getWikiTree(WS, db);
    expect(tree.map((entry) => entry.path)).toEqual([
      "projects",
      "projects/site",
      "projects/site/notes",
    ]);
    expect(tree.map((entry) => entry.nodeType)).toEqual(["folder", "folder", "page"]);
    expect(tree[1]?.childCount).toBe(1);
  });

  it("honors an explicit title and preserves it across body rewrites", async () => {
    await writeWikiPage(
      { workspaceId: WS, path: "q3-planning", body: "goals go here", title: "Q3 Planning" },
      db,
    );
    let { pages } = await resolveWikiPages(WS, ["q3-planning"], db);
    expect(pages[0]?.title).toBe("Q3 Planning");
    // An agent rewrite without an H1 keeps the human-set name...
    await writeWikiPage({ workspaceId: WS, path: "q3-planning", body: "updated goals" }, db);
    ({ pages } = await resolveWikiPages(WS, ["q3-planning"], db));
    expect(pages[0]?.title).toBe("Q3 Planning");
    // ...while a body with an H1 still wins when no explicit title is given.
    await writeWikiPage({ workspaceId: WS, path: "q3-planning", body: "# Q3 Plan v2" }, db);
    ({ pages } = await resolveWikiPages(WS, ["q3-planning"], db));
    expect(pages[0]?.title).toBe("Q3 Plan v2");
  });

  it("honors an explicit empty title on create and clear (Notion-style Untitled)", async () => {
    // The UI creates pages with an empty name; nothing may auto-fill it.
    await writeWikiPage({ workspaceId: WS, path: "fresh-page", body: "", title: "" }, db);
    let { pages } = await resolveWikiPages(WS, ["fresh-page"], db);
    expect(pages[0]?.title).toBe("");
    // Clearing an existing name sticks, even when the body has an H1.
    await writeWikiPage({ workspaceId: WS, path: "fresh-page", body: "# Heading", title: "" }, db);
    ({ pages } = await resolveWikiPages(WS, ["fresh-page"], db));
    expect(pages[0]?.title).toBe("");
  });

  it("updates in place and reports unchanged writes", async () => {
    await writeWikiPage({ workspaceId: WS, path: "notes", body: "a\nb" }, db);
    const updated = await writeWikiPage({ workspaceId: WS, path: "notes", body: "a\nb\nc" }, db);
    expect(updated.action).toBe("updated");
    const unchanged = await writeWikiPage({ workspaceId: WS, path: "notes", body: "a\nb\nc" }, db);
    expect(unchanged.action).toBe("unchanged");
  });

  it("allows a slug to be reused under a different folder", async () => {
    await writeWikiPage({ workspaceId: WS, path: "projects/site", body: "" }, db);
    const result = await writeWikiPage({ workspaceId: WS, path: "archive/site", body: "" }, db);
    expect(result.action).toBe("created");
  });

  it("keeps slugs independent across workspaces", async () => {
    await writeWikiPage({ workspaceId: WS, path: "notes", body: "mine" }, db);
    const other = await writeWikiPage(
      { workspaceId: "ws-other", path: "notes", body: "theirs" },
      db,
    );
    expect(other.action).toBe("created");
  });

  it("rebuilds the derived link index on every write", async () => {
    await writeWikiPage({ workspaceId: WS, path: "target-page", body: "# Target" }, db);
    await writeWikiPage(
      {
        workspaceId: WS,
        path: "from-page",
        body: "Links to [[target-page]] and [[source:linear:issue:ENG-9]].",
      },
      db,
    );
    expect(await getWikiBacklinks(WS, "target-page", db)).toMatchObject([{ slug: "from-page" }]);
    await writeWikiPage({ workspaceId: WS, path: "from-page", body: "No more links." }, db);
    expect(await getWikiBacklinks(WS, "target-page", db)).toEqual([]);
  });
});

describe("resolveWikiPages", () => {
  it("resolves exact paths and unique basenames", async () => {
    await writeWikiPage({ workspaceId: WS, path: "projects/site", body: "# Site" }, db);
    const { pages, missing } = await resolveWikiPages(WS, ["site", "projects/site", "ghost"], db);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.slug).toBe("site");
    expect(missing).toEqual(["ghost"]);
  });

  it("does not resolve ambiguous or missing basenames", async () => {
    await writeWikiPage({ workspaceId: WS, path: "projects/goals", body: "work" }, db);
    await writeWikiPage({ workspaceId: WS, path: "personal/goals", body: "life" }, db);
    const { pages, missing } = await resolveWikiPages(WS, ["goals", "projects/goals", "ghost"], db);
    expect(pages.map((page) => page.path)).toEqual(["projects/goals"]);
    expect(missing).toEqual(["goals", "ghost"]);
  });
});

describe("moveWikiNode", () => {
  it("moves a folder subtree and rewrites page and timeline links", async () => {
    await createWikiFolder({ workspaceId: WS, path: "projects/site" }, db);
    await writeWikiPage({ workspaceId: WS, path: "projects/site/notes", body: "n" }, db);
    await createWikiFolder({ workspaceId: WS, path: "archive" }, db);
    await writeWikiPage(
      { workspaceId: WS, path: "referrer", body: "See [[projects/site/notes|Notes]]." },
      db,
    );
    await addWikiTimelineEntry(
      {
        workspaceId: WS,
        path: "referrer",
        at: new Date("2026-08-01T10:00:00Z"),
        text: "Reviewed [[projects/site/notes]]",
      },
      db,
    );
    const result = await moveWikiNode(
      { workspaceId: WS, path: "projects/site", newParentPath: "archive" },
      db,
    );
    expect(result.movedDescendants).toBe(1);
    expect(result.rewrittenReferrers).toEqual(["referrer"]);
    expect(result.txids).toHaveLength(3);
    const tree = await getWikiTree(WS, db);
    expect(tree.map((entry) => entry.path).sort()).toEqual([
      "archive",
      "archive/site",
      "archive/site/notes",
      "projects",
      "referrer",
    ]);
    const referrer = (await resolveWikiPages(WS, ["referrer"], db)).pages[0];
    expect(referrer?.content).toBe("See [[archive/site/notes|Notes]].");
    const timeline = await listWikiTimeline({ workspaceId: WS, path: "referrer" }, db);
    expect(timeline[0]?.text).toBe("Reviewed [[archive/site/notes]]");
  });

  it("refuses cycles and missing parents", async () => {
    await createWikiFolder({ workspaceId: WS, path: "a/b" }, db);
    await expect(
      moveWikiNode({ workspaceId: WS, path: "a", newParentPath: "a/b" }, db),
    ).rejects.toThrow(/inside its own subtree/);
    await expect(
      moveWikiNode({ workspaceId: WS, path: "a/b", newParentPath: "ghost" }, db),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("deleteWikiPage", () => {
  it("requires recursive for subtrees and versions every deletion", async () => {
    await writeWikiPage({ workspaceId: WS, path: "projects/site", body: "x" }, db);
    await expect(deleteWikiPage({ workspaceId: WS, path: "projects" }, db)).rejects.toThrow(
      WikiError,
    );
    const result = await deleteWikiPage({ workspaceId: WS, path: "projects", recursive: true }, db);
    expect(result.deletedPaths).toEqual(["projects/site", "projects"]);
    const changes = await recentWikiChanges(WS, { since: new Date(Date.now() - 60_000) }, db);
    expect(changes.filter((change) => change.deleted)).toHaveLength(2);
    expect(await getWikiTree(WS, db)).toEqual([]);
  });
});

describe("retrieval", () => {
  beforeEach(async () => {
    await writeWikiPage(
      {
        workspaceId: WS,
        path: "projects/website-redesign",
        body: "# Website Redesign\n\nRelaunch the marketing site with the agency.",
        kind: "project",
      },
      db,
    );
    await writeWikiPage(
      {
        workspaceId: WS,
        path: "people/ada-lovelace",
        body: "# Ada Lovelace\n\nFounding engineer, leads the platform work.",
        kind: "person",
      },
      db,
    );
  });

  it("searches lexically with typo-tolerant title matching", async () => {
    const hits = await searchWiki(WS, { text: "marketing relaunch" }, db);
    expect(hits[0]?.slug).toBe("website-redesign");
    const typo = await searchWiki(WS, { text: "Ada Lovelase" }, db);
    expect(typo.some((hit) => hit.slug === "ada-lovelace")).toBe(true);
  });

  it("greps with line numbers", async () => {
    const matches = await grepWiki(WS, { pattern: "founding engineer", ignoreCase: true }, db);
    expect(matches).toMatchObject([{ slug: "ada-lovelace", lineNumber: 3 }]);
  });

  it("scopes retrieval to the workspace", async () => {
    expect(await searchWiki("ws-other", { text: "marketing relaunch" }, db)).toEqual([]);
    expect(await grepWiki("ws-other", { pattern: "engineer", ignoreCase: true }, db)).toEqual([]);
  });
});

describe("timeline", () => {
  it("adds and lists entries separately from the body", async () => {
    await writeWikiPage({ workspaceId: WS, path: "projects/site", body: "# Site" }, db);
    await addWikiTimelineEntry(
      {
        workspaceId: WS,
        path: "projects/site",
        at: new Date("2026-08-01T10:00:00Z"),
        text: "Kickoff call [[source:jamie:meeting:xyz]]",
      },
      db,
    );
    await addWikiTimelineEntry(
      {
        workspaceId: WS,
        path: "projects/site",
        at: new Date("2026-08-05T10:00:00Z"),
        text: "Budget approved",
      },
      db,
    );
    const entries = await listWikiTimeline({ workspaceId: WS, path: "projects/site" }, db);
    expect(entries.map((entry) => entry.text)).toEqual([
      "Budget approved",
      "Kickoff call [[source:jamie:meeting:xyz]]",
    ]);
    const since = await listWikiTimeline(
      { workspaceId: WS, path: "projects/site", since: new Date("2026-08-03T00:00:00Z") },
      db,
    );
    expect(since).toHaveLength(1);
  });
});

describe("recentWikiChanges", () => {
  it("aggregates writes per page with line deltas", async () => {
    await writeWikiPage({ workspaceId: WS, path: "notes", body: "a\nb" }, db);
    await writeWikiPage({ workspaceId: WS, path: "notes", body: "a\nb\nc\nd" }, db);
    await writeWikiPage({ workspaceId: WS, path: "notes", body: "a\nb\nc" }, db);
    const changes = await recentWikiChanges(WS, { since: new Date(Date.now() - 60_000) }, db);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ slug: "notes", writes: 3, addedLines: 4, removedLines: 1 });
  });
});
