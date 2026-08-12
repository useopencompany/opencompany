import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "@opencompany/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresKnowledgeRepository } from "./knowledge-repository";

const migrationPaths = [
  "drizzle/0208_goat_headless_knowledge_idempotency.sql",
  "drizzle/0209_goat_brain_asset_idempotency.sql",
  "drizzle/0210_goat_skill_import_idempotency.sql",
].map((migration) => path.resolve(import.meta.dirname, "../../..", migration));

describe("Postgres Knowledge repository", () => {
  let database: PGlite;
  let repository: PostgresKnowledgeRepository;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(BASE_SCHEMA);
    for (const migrationPath of migrationPaths) {
      const migration = await readFile(migrationPath, "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await database.exec(statement);
      }
    }
    repository = new PostgresKnowledgeRepository(drizzle(database));
  });

  beforeEach(async () => {
    await database.exec(`
      DELETE FROM goat.knowledge_command_idempotency;
      DELETE FROM goat.skills;
    `);
  });

  afterAll(async () => {
    await database.close();
  });

  it("replays one skill create and rejects key reuse for a different command", async () => {
    const command = {
      actor: actor(),
      idempotencyKey: "skill-create-1",
      name: "Research",
      description: "Find primary sources.",
    };

    const created = await repository.createSkill(command);
    const replay = await repository.createSkill(command);

    expect(replay).toEqual(created);
    await expect(
      repository.createSkill({ ...command, name: "Different skill" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      database.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM goat.skills WHERE workspace_id = $1",
        [command.actor.workspaceId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("scopes the same idempotency key independently per actor and Workspace", async () => {
    const first = await repository.createSkill({
      actor: actor(),
      idempotencyKey: "same-key",
      name: "Workspace one",
      description: "",
    });
    const second = await repository.createSkill({
      actor: actor({ userId: "user_2", workspaceId: "workspace_2" }),
      idempotencyKey: "same-key",
      name: "Workspace two",
      description: "",
    });

    expect(second.id).not.toBe(first.id);
    await expect(
      database.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM goat.skills"),
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });

  it("keeps imported skills immutable through the canonical update repository", async () => {
    await database.query(
      `INSERT INTO goat.skills (
        id, workspace_id, slug, name, description, instructions, status,
        source_type, source_url, source_ref, source_path, resolved_commit
      ) VALUES ($1, $2, $3, $4, '', 'Do the work.', 'active', 'github',
        'https://github.com/example/skills', 'main', 'research/SKILL.md', $5)`,
      ["skill_imported", "workspace_1", "imported", "Imported", "a".repeat(40)],
    );

    await expect(
      repository.updateSkill({
        actor: actor(),
        slug: "imported",
        name: "Changed",
        description: "",
        instructions: "Changed",
        status: "active",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("replays Skill imports durably and deduplicates the same resolved source", async () => {
    const command = {
      actor: actor(),
      idempotencyKey: "skill-import-1",
      name: "Imported",
      description: "Imported instructions.",
      instructions: "Do the imported work.",
      source: {
        type: "github" as const,
        url: "https://github.com/example/skills",
        ref: "main",
        path: "research",
      },
      resolvedCommit: "a".repeat(40),
      integrity: `sha256:${"b".repeat(64)}`,
    };

    const created = await repository.importSkill(command);
    const replay = await repository.importSkill(command);
    const sourceReplay = await repository.importSkill({
      ...command,
      idempotencyKey: "skill-import-2",
    });

    expect(created).toMatchObject({ skill: { slug: "imported" }, idempotentReplay: false });
    expect(replay).toMatchObject({ skill: { id: created.skill.id }, idempotentReplay: true });
    expect(sourceReplay).toMatchObject({
      skill: { id: created.skill.id },
      idempotentReplay: true,
    });
    await expect(
      database.query<{ skills: number; commands: number; incomplete: number; resources: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM goat.skills) AS skills,
           COUNT(*)::int AS commands,
           COUNT(*) FILTER (WHERE completed_at IS NULL)::int AS incomplete,
           COUNT(DISTINCT resource_id)::int AS resources
         FROM goat.knowledge_command_idempotency
         WHERE operation = 'skill.import'`,
      ),
    ).resolves.toMatchObject({
      rows: [{ skills: 1, commands: 2, incomplete: 0, resources: 1 }],
    });
    await expect(
      repository.importSkill({ ...command, resolvedCommit: "c".repeat(40) }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("allocates distinct slugs for different imports with the same name", async () => {
    const first = await repository.importSkill({
      actor: actor(),
      idempotencyKey: "skill-import-a",
      name: "Imported",
      description: "",
      instructions: "First.",
      source: {
        type: "github",
        url: "https://github.com/example/skills",
        ref: "main",
        path: "first",
      },
      resolvedCommit: "a".repeat(40),
      integrity: `sha256:${"b".repeat(64)}`,
    });
    const second = await repository.importSkill({
      actor: actor(),
      idempotencyKey: "skill-import-b",
      name: "Imported",
      description: "",
      instructions: "Second.",
      source: {
        type: "github",
        url: "https://github.com/example/skills",
        ref: "main",
        path: "second",
      },
      resolvedCommit: "c".repeat(40),
      integrity: `sha256:${"d".repeat(64)}`,
    });

    expect([first.skill.slug, second.skill.slug]).toEqual(["imported", "imported-2"]);
  });

  it("scopes identical imported sources independently per Workspace", async () => {
    const source = {
      type: "github" as const,
      url: "https://github.com/example/skills",
      ref: "main",
      path: "research",
    };
    const first = await repository.importSkill({
      actor: actor(),
      idempotencyKey: "shared-import-key",
      name: "Imported",
      description: "",
      instructions: "First Workspace.",
      source,
      resolvedCommit: "a".repeat(40),
      integrity: `sha256:${"b".repeat(64)}`,
    });
    const second = await repository.importSkill({
      actor: actor({ userId: "user_2", workspaceId: "workspace_2" }),
      idempotencyKey: "shared-import-key",
      name: "Imported",
      description: "",
      instructions: "Second Workspace.",
      source,
      resolvedCommit: "a".repeat(40),
      integrity: `sha256:${"b".repeat(64)}`,
    });

    expect(second.skill.id).not.toBe(first.skill.id);
    await expect(
      database.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM goat.skills"),
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });
});

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_1",
    workspaceId: "workspace_1",
    role: "admin",
    permissions: [],
    authenticationMethod: "session",
    ...overrides,
  };
}

const BASE_SCHEMA = `
CREATE SCHEMA goat;
CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);
CREATE TABLE goat.workspaces (id text PRIMARY KEY);
INSERT INTO goat.users (workos_user_id) VALUES ('user_1'), ('user_2');
INSERT INTO goat.workspaces (id) VALUES ('workspace_1'), ('workspace_2');
CREATE TABLE goat.skills (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  created_by_workos_id text REFERENCES goat.users(workos_user_id) ON DELETE SET NULL,
  source_type text,
  source_url text,
  source_ref text,
  source_path text,
  resolved_commit text,
  integrity text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX goat_skills_workspace_slug_idx
  ON goat.skills (workspace_id, slug) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX goat_skills_workspace_source_idx
  ON goat.skills (workspace_id, source_url, source_ref, source_path)
  WHERE source_type IS NOT NULL AND archived_at IS NULL;
`;
