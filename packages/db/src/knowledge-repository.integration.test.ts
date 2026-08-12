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
`;
