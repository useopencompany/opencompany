// Command-dispatch characterization for the wiki agent tool against embedded
// Postgres (PGlite). This drives the API-owned WikiCommandApplicationService over
// the Postgres repository — the same stack the runner and MCP use — and asserts
// the byte-compatible output shapes agents see. It replaces the old
// apps/web/lib/wiki-tool.test.ts, which tested the deleted direct executor.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import {
  type Actor,
  WIKI_READ_PERMISSION,
  WIKI_WRITE_PERMISSION,
  WikiCommandApplicationService,
} from "@opencompany/core";
import type { WikiToolInput } from "@opencompany/wiki/tool";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { PostgresWikiCommandRepository } from "./wiki-command-repository";

const WS = "ws-wiki-command";
const MIGRATIONS = ["0195_goat_wiki.sql", "0220_goat_wiki_folders.sql"];

const actor: Actor = {
  userId: "user_1",
  workspaceId: WS,
  role: "admin",
  permissions: [WIKI_READ_PERMISSION, WIKI_WRITE_PERMISSION],
  authenticationMethod: "service",
};

let service: WikiCommandApplicationService;
let sequence = 0;

// Each call gets a distinct idempotency key, mirroring the per-tool-call keys the
// real callers build (agent-wiki:<turn>:<toolCall>).
const run = (command: WikiToolInput) =>
  service.execute({ actor, command, idempotencyKey: `wiki-command-test:${++sequence}` });

beforeAll(async () => {
  const pglite = new PGlite({ extensions: { pg_trgm } });
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
  await pglite.exec(
    `INSERT INTO goat.workspaces (id) VALUES ('${WS}'); INSERT INTO goat.users (workos_user_id) VALUES ('user_1');`,
  );
  service = new WikiCommandApplicationService(new PostgresWikiCommandRepository(drizzle(pglite)));
});

describe("wiki command service", () => {
  it("writes, lists the tree, and reads folders and backlinks", async () => {
    const write = await run({
      command: "write",
      path: "projects/site",
      body: "# Site\n\nSee [[people/ada]] for the owner.",
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

    await run({ command: "write", path: "other/projects", body: "# A page named Projects" });
    const parent = await run({ command: "read", pages: "projects" });
    expect(parent.ok && parent.result).toMatchObject({
      folders: [{ path: "projects", children: ["projects/site"] }],
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

  it("replays a repeated timeline-add on the same idempotency key", async () => {
    const first = await service.execute({
      actor,
      command: {
        command: "timeline-add",
        pages: "site",
        text: "Launched",
        at: "2026-08-02T00:00:00Z",
      },
      idempotencyKey: "wiki-command-test:timeline-replay",
    });
    const replay = await service.execute({
      actor,
      command: {
        command: "timeline-add",
        pages: "site",
        text: "Launched",
        at: "2026-08-02T00:00:00Z",
      },
      idempotencyKey: "wiki-command-test:timeline-replay",
    });
    expect(first).toEqual(replay);
    const timeline = await run({ command: "timeline", pages: "site" });
    const launched =
      timeline.ok &&
      (timeline.result as { entries: Array<{ text: string }> }).entries.filter(
        (entry) => entry.text === "Launched",
      );
    expect(launched && launched.length).toBe(1);
  });

  it("moves and deletes", async () => {
    await run({ command: "mkdir", path: "archive" });
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

  it("forbids a command when the actor lacks the wiki permission", async () => {
    const readerOnly: Actor = { ...actor, permissions: [WIKI_READ_PERMISSION] };
    await expect(
      service.execute({
        actor: readerOnly,
        command: { command: "write", path: "projects/x", body: "# X" },
        idempotencyKey: "wiki-command-test:forbidden",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
