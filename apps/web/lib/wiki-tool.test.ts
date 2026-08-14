// Dispatch-level tests for the `wiki` tool executor against embedded Postgres.
// The storage layer has its own deep suite in @opencompany/db; this covers the
// command dispatch, result shapes agents see, and WikiError → { ok: false }.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import type { WikiToolInput } from "@opencompany/wiki/tool";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { runWikiToolForUser } from "./wiki-tool";

const WS = "ws-wiki-tool";
const MIGRATION = path.join(__dirname, "..", "..", "..", "drizzle", "0195_goat_wiki.sql");

let db: ReturnType<typeof drizzle>;

const run = (toolInput: WikiToolInput) =>
  runWikiToolForUser({ workspaceId: WS, userWorkosId: "user_1", toolInput, db });

beforeAll(async () => {
  const pglite = new PGlite({ extensions: { pg_trgm } });
  await pglite.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  await pglite.exec("CREATE SCHEMA goat;");
  await pglite.exec("CREATE TABLE goat.workspaces (id text PRIMARY KEY);");
  await pglite.exec("CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);");
  for (const statement of (await readFile(MIGRATION, "utf8")).split("--> statement-breakpoint")) {
    await pglite.exec(statement);
  }
  await pglite.exec(
    `INSERT INTO goat.workspaces (id) VALUES ('${WS}'); INSERT INTO goat.users (workos_user_id) VALUES ('user_1');`,
  );
  db = drizzle(pglite);
});

describe("wiki tool", () => {
  it("writes, lists the tree, and reads with subpages and backlinks", async () => {
    const write = await run({
      command: "write",
      path: "projects/site",
      body: "# Site\n\nSee [[ada]] for the owner.",
      kind: "project",
    });
    expect(write).toMatchObject({
      ok: true,
      result: { action: "created", slug: "site", createdAncestors: ["projects"] },
    });
    await run({ command: "write", path: "people/ada", body: "# Ada", kind: "person" });

    const tree = await run({ command: "tree" });
    expect(tree.ok && tree.result).toMatchObject({ total: 4 });

    const read = await run({ command: "read", pages: "ada" });
    expect(read.ok && read.result).toMatchObject({
      pages: [{ slug: "ada", path: "people/ada", backlinks: ["projects/site"] }],
    });

    const parent = await run({ command: "read", pages: "projects" });
    expect(parent.ok && parent.result).toMatchObject({
      pages: [{ subpages: ["projects/site"] }],
    });
  });

  it("greps, searches, and reports recent changes", async () => {
    const grep = await run({ command: "grep", query: "owner" });
    expect(grep.ok && grep.result).toMatchObject({
      matches: [{ path: "projects/site", lineNumber: 3 }],
    });

    const search = await run({ command: "search", query: "site owner" });
    expect(search.ok).toBe(true);

    const recent = await run({ command: "recent", since: "1h" });
    expect(recent.ok && recent.result).toMatchObject({
      changes: expect.arrayContaining([expect.objectContaining({ path: "projects/site" })]),
    });
  });

  it("keeps the timeline outside the page body", async () => {
    const add = await run({
      command: "timeline-add",
      pages: "site",
      text: "Kickoff [[source:jamie:meeting:1]]",
      at: "2026-08-01T10:00:00Z",
    });
    expect(add.ok).toBe(true);
    const timeline = await run({ command: "timeline", pages: "site" });
    expect(timeline.ok && timeline.result).toMatchObject({
      entries: [{ at: "2026-08-01T10:00:00.000Z", text: "Kickoff [[source:jamie:meeting:1]]" }],
    });
    const read = await run({ command: "read", pages: "site" });
    expect(read.ok && JSON.stringify(read.result)).not.toContain("Kickoff");
  });

  it("moves and deletes", async () => {
    await run({ command: "write", path: "archive", body: "" });
    const move = await run({ command: "move", pages: "site", to: "archive" });
    expect(move.ok && move.result).toMatchObject({ path: "archive/site" });
    const del = await run({ command: "delete", pages: "archive", recursive: true });
    expect(del.ok && del.result).toMatchObject({ deletedPaths: ["archive/site", "archive"] });
  });

  it("maps domain errors to ok: false instead of throwing", async () => {
    expect(await run({ command: "read" })).toMatchObject({ ok: false });
    expect(await run({ command: "write", path: "Bad Path", body: "" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Invalid wiki path"),
    });
    expect(await run({ command: "delete", pages: "ghost" })).toMatchObject({ ok: false });
    expect(await run({ command: "grep", query: "(" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Invalid grep pattern"),
    });
  });
});
