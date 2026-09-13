// Who may change a wiki.
//
// `canManage` on the wiki DTO is the client's only signal for whether to offer a control, so it has
// to agree with `requireWikiOwner`, which is what actually rejects the write. Against embedded
// Postgres so the access SQL runs for real.
//
// The access mutations themselves (invite, revoke, the default wiki's exemption) are covered
// against the real migrations in packages/db/src/wikis.integration.test.ts and are not repeated.

import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "@opencompany/core";
import { snapshotPGliteSchema } from "@opencompany/db/test-schema-snapshot";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import { createWikiControlService } from "./wiki-control";

function actorFor(userId: string, role: "admin" | "member"): Actor {
  return {
    userId,
    workspaceId: "workspace_1",
    role,
    permissions: ["wiki:read", "wiki:write"],
    authenticationMethod: "session",
  };
}

const founder = actorFor("user_founder", "admin");
const cofounder = actorFor("user_cofounder", "member");
const employee = actorFor("user_employee", "member");

describe("wiki control", () => {
  let database: PGlite;
  let service: ReturnType<typeof createWikiControlService>;
  let restoreDatabase: () => Promise<PGlite>;

  beforeAll(async () => {
    restoreDatabase = await snapshotPGliteSchema(async (database) => {
      // Only the tables the access condition reads. `listWorkspaceMembers` selects every column of
      // goat.users, so the roster-reading paths are deliberately left to the db-package tests
      // rather than kept in step with that table by hand here.
      await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.workspace_members (workspace_id text, user_workos_id text, role text);
      CREATE TABLE goat.wikis (
        id text PRIMARY KEY,
        workspace_id text NOT NULL,
        name text NOT NULL,
        slug text NOT NULL,
        instructions text NOT NULL DEFAULT '',
        access text NOT NULL DEFAULT 'workspace',
        is_default boolean NOT NULL DEFAULT false,
        created_by_workos_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX goat_wikis_workspace_slug_idx ON goat.wikis (workspace_id, slug);
      CREATE TABLE goat.wiki_members (
        id text PRIMARY KEY,
        wiki_id text NOT NULL REFERENCES goat.wikis(id) ON DELETE CASCADE,
        user_workos_id text NOT NULL,
        added_by_workos_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX goat_wiki_members_wiki_user_idx
        ON goat.wiki_members (wiki_id, user_workos_id);
      INSERT INTO goat.workspace_members VALUES
        ('workspace_1', 'user_founder', 'admin'),
        ('workspace_1', 'user_cofounder', 'member'),
        ('workspace_1', 'user_employee', 'member');
      INSERT INTO goat.wikis (id, workspace_id, name, slug, is_default, created_by_workos_id)
        VALUES ('wiki_default', 'workspace_1', 'Company', 'company', true, 'user_founder');
    `);
    });
  });

  beforeEach(async () => {
    database = await restoreDatabase();
    service = createWikiControlService({ db: drizzle(database) });
  });

  afterEach(async () => {
    await database.close();
  });

  it("lets a wiki's creator manage it", async () => {
    const wiki = await service.createWiki(cofounder, { name: "C-level", access: "restricted" });
    expect(wiki.canManage).toBe(true);
  });

  it("does not make an admin a backdoor into a restricted wiki they were not invited to", async () => {
    const wiki = await service.createWiki(cofounder, { name: "C-level", access: "restricted" });

    // `requireWikiOwner` grants admins that right, but reachability is resolved first, so an admin
    // outside a restricted wiki never gets far enough to use them. A c-level wiki is private from
    // the workspace's admins too, which is the whole point of it.
    expect((await service.listWikis(founder)).map((entry) => entry.id)).toEqual(["wiki_default"]);
    await expect(service.updateWiki(founder, wiki.id, { name: "Theirs" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("lets an admin manage a workspace-visible wiki someone else created", async () => {
    const shared = await service.createWiki(cofounder, { name: "Handbook", access: "workspace" });
    const asAdmin = (await service.listWikis(founder)).find((entry) => entry.id === shared.id);
    expect(asAdmin?.canManage).toBe(true);
  });

  it("reports canManage false on a wiki someone else created, and the API agrees", async () => {
    const shared = await service.createWiki(cofounder, { name: "Handbook", access: "workspace" });

    const seen = (await service.listWikis(employee)).find((entry) => entry.id === shared.id);
    expect(seen?.canManage).toBe(false);

    // The flag has to predict the write, not merely decorate the row.
    await expect(
      service.updateWiki(employee, shared.id, { name: "Theirs" }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("hides a restricted wiki from a non-member rather than showing it unmanageable", async () => {
    const wiki = await service.createWiki(cofounder, { name: "C-level", access: "restricted" });

    expect((await service.listWikis(employee)).map((entry) => entry.id)).toEqual(["wiki_default"]);
    // Absent, never forbidden: a 403 here would confirm the wiki exists.
    await expect(service.updateWiki(employee, wiki.id, { name: "Theirs" })).rejects.toMatchObject({
      status: 404,
    });
  });
});
