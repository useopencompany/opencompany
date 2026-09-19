import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "@opencompany/core";
import { snapshotPGliteSchema } from "@opencompany/db/test-schema-snapshot";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import { createProjectService } from "./projects";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: ["chat:read", "chat:write"],
  authenticationMethod: "session",
};

describe("sidebar project storage", () => {
  let database: PGlite;
  let service: ReturnType<typeof createProjectService>;
  let restoreDatabase: () => Promise<PGlite>;

  beforeAll(async () => {
    restoreDatabase = await snapshotPGliteSchema(async (database) => {
      await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.users (
        workos_user_id text PRIMARY KEY,
        sidebar_projects_enabled boolean NOT NULL DEFAULT false,
        subagents_enabled boolean NOT NULL DEFAULT false,
        company_agents_enabled boolean NOT NULL DEFAULT false
      );
      CREATE TABLE goat.workspace_members (workspace_id text, user_workos_id text);
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
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, slug)
      );
      CREATE TABLE goat.wiki_members (
        id text PRIMARY KEY,
        wiki_id text NOT NULL REFERENCES goat.wikis(id) ON DELETE CASCADE,
        user_workos_id text NOT NULL,
        added_by_workos_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (wiki_id, user_workos_id)
      );
      CREATE TABLE goat.projects (
        id text PRIMARY KEY,
        user_workos_id text NOT NULL,
        workspace_id text NOT NULL,
        wiki_id text UNIQUE REFERENCES goat.wikis(id) ON DELETE SET NULL,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE goat.chat_sessions (
        id text PRIMARY KEY,
        user_workos_id text NOT NULL,
        project_id text REFERENCES goat.projects(id) ON DELETE SET NULL,
        title text,
        closed_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO goat.users VALUES ('user_1', true), ('user_2', true), ('disabled', false);
      INSERT INTO goat.workspace_members VALUES
        ('workspace_1', 'user_1'), ('workspace_2', 'user_1'),
        ('workspace_1', 'user_2'), ('workspace_1', 'disabled');
      INSERT INTO goat.chat_sessions (id, user_workos_id, title, updated_at) VALUES
        ('chat_1', 'user_1', 'First', '2026-07-01T09:00:00Z'),
        ('chat_2', 'user_1', 'Second', '2026-07-02T09:00:00Z'),
        ('chat_closed', 'user_1', 'Archived', '2026-07-03T09:00:00Z'),
        ('chat_other_owner', 'user_2', 'Theirs', '2026-07-04T09:00:00Z');
      UPDATE goat.chat_sessions SET closed_at = now() WHERE id = 'chat_closed';
    `);
    });
  });

  beforeEach(async () => {
    database = await restoreDatabase();
    service = createProjectService({ db: drizzle(database) });
  });

  afterEach(async () => {
    await database.close();
  });

  const create = (id: string, name: string) => service.create(actor, { id, name });

  it("creates a project once across retries of the same creation id", async () => {
    expect(await create("project_1", "Launch")).toMatchObject([
      { id: "project_1", name: "Launch", wikiSlug: "launch", conversationIds: [] },
    ]);
    expect(await create("project_1", "Launch")).toHaveLength(1);
    const wikis = await database.query<{
      name: string;
      access: string;
      created_by_workos_id: string;
      member_id: string;
    }>(`
      SELECT wiki.name, wiki.access, wiki.created_by_workos_id, member.user_workos_id AS member_id
      FROM goat.projects project
      JOIN goat.wikis wiki ON wiki.id = project.wiki_id
      JOIN goat.wiki_members member ON member.wiki_id = wiki.id
      WHERE project.id = 'project_1'
    `);
    expect(wikis.rows).toEqual([
      {
        name: "Launch",
        access: "restricted",
        created_by_workos_id: "user_1",
        member_id: "user_1",
      },
    ]);
  });

  it("repairs a Project whose first creation stopped before its wiki was attached", async () => {
    await database.exec(`
      INSERT INTO goat.projects (id, user_workos_id, workspace_id, name)
      VALUES ('project_interrupted', 'user_1', 'workspace_1', 'Recovery plan')
    `);

    expect(await create("project_interrupted", "Ignored retry name")).toMatchObject([
      {
        id: "project_interrupted",
        name: "Recovery plan",
        wikiSlug: "recovery-plan",
      },
    ]);
    await database.exec("UPDATE goat.projects SET wiki_id = NULL WHERE id = 'project_interrupted'");
    await create("project_interrupted", "Ignored retry name");
    const wikis = await database.query<{ name: string }>(`
      SELECT name
      FROM goat.wikis
      WHERE created_by_workos_id = 'user_1' AND name = 'Recovery plan'
    `);
    expect(wikis.rows).toEqual([{ name: "Recovery plan" }]);
  });

  it("repairs a missing wiki when the Project is renamed", async () => {
    await database.exec(`
      INSERT INTO goat.projects (id, user_workos_id, workspace_id, name)
      VALUES ('project_interrupted', 'user_1', 'workspace_1', 'Recovery plan')
    `);

    expect(await service.rename(actor, "project_interrupted", "Recovered plan")).toMatchObject([
      {
        id: "project_interrupted",
        name: "Recovered plan",
        wikiSlug: "recovered-plan",
      },
    ]);
  });

  it("files a conversation, lists it newest first, and moves it between projects", async () => {
    await create("project_1", "Launch");
    await create("project_2", "Research");

    await service.fileConversation(actor, "project_1", "chat_1");
    const filed = await service.fileConversation(actor, "project_1", "chat_2");
    expect(filed.find((project) => project.id === "project_1")?.conversationIds).toEqual([
      "chat_2",
      "chat_1",
    ]);

    const moved = await service.fileConversation(actor, "project_2", "chat_1");
    expect(moved.find((project) => project.id === "project_1")?.conversationIds).toEqual([
      "chat_2",
    ]);
    expect(moved.find((project) => project.id === "project_2")?.conversationIds).toEqual([
      "chat_1",
    ]);
  });

  it("keeps archived conversations out of a project listing", async () => {
    await create("project_1", "Launch");
    const filed = await service.fileConversation(actor, "project_1", "chat_closed");
    expect(filed[0]?.conversationIds).toEqual([]);
  });

  it("returns a conversation to Recents only from the project it is in", async () => {
    await create("project_1", "Launch");
    await create("project_2", "Research");
    await service.fileConversation(actor, "project_1", "chat_1");

    await expect(service.removeConversation(actor, "project_2", "chat_1")).rejects.toBeInstanceOf(
      ApiError,
    );

    const removed = await service.removeConversation(actor, "project_1", "chat_1");
    expect(removed.every((project) => project.conversationIds.length === 0)).toBe(true);
  });

  it("keeps a deleted Project's conversations and wiki", async () => {
    await create("project_1", "Launch");
    await service.fileConversation(actor, "project_1", "chat_1");

    expect(await service.remove(actor, "project_1")).toEqual([]);
    const chats = await database.query<{ id: string; project_id: string | null }>(
      "SELECT id, project_id FROM goat.chat_sessions WHERE id = 'chat_1'",
    );
    expect(chats.rows).toEqual([{ id: "chat_1", project_id: null }]);
    const wikis = await database.query<{ name: string }>("SELECT name FROM goat.wikis");
    expect(wikis.rows).toEqual([{ name: "Launch" }]);
  });

  it("refuses another member's project, another member's chat, and a disabled preference", async () => {
    await create("project_1", "Launch");

    const otherMember = { ...actor, userId: "user_2" };
    await expect(service.rename(otherMember, "project_1", "Theirs")).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(service.remove(otherMember, "project_1")).rejects.toBeInstanceOf(ApiError);
    await expect(service.assertOwned(otherMember, "project_1")).rejects.toBeInstanceOf(ApiError);
    await expect(
      service.fileConversation(actor, "project_1", "chat_other_owner"),
    ).rejects.toBeInstanceOf(ApiError);

    // A project is scoped to the workspace it was made in, not just to its owner.
    const otherWorkspace = { ...actor, workspaceId: "workspace_2" };
    await expect(service.assertOwned(otherWorkspace, "project_1")).rejects.toBeInstanceOf(ApiError);

    await expect(service.list({ ...actor, userId: "disabled" })).rejects.toBeInstanceOf(ApiError);
    await expect(service.list({ ...actor, permissions: [] })).rejects.toBeInstanceOf(ApiError);
  });

  it("renames a project and keeps what it holds", async () => {
    await create("project_1", "Launch");
    await service.fileConversation(actor, "project_1", "chat_1");

    expect(await service.rename(actor, "project_1", "Launch week")).toMatchObject([
      {
        id: "project_1",
        name: "Launch week",
        wikiSlug: "launch-week",
        conversationIds: ["chat_1"],
      },
    ]);
  });
});
