import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { computeArtifactIntegrity } from "@opencompany/agent-runtime";
import type { Actor, ResolvedSkillBundle } from "@opencompany/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresSkillBundleRepository } from "./skill-bundle-repository";

describe("Postgres immutable Skill bundle repository", () => {
  let database: PGlite;
  let repository: PostgresSkillBundleRepository;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.workspaces (id text PRIMARY KEY);
      INSERT INTO goat.workspaces (id) VALUES ('workspace_1'), ('workspace_2');
    `);
    const migration = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../..",
        "drizzle/0222_goat_immutable_skill_bundles.sql",
      ),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
    repository = new PostgresSkillBundleRepository(drizzle(database));
  });

  beforeEach(async () => {
    await database.exec(`
      DELETE FROM goat.skill_installations;
      DELETE FROM goat.skill_bundles;
    `);
  });

  afterAll(async () => {
    await database.close();
  });

  it("persists a complete bundle and installation atomically with durable replay", async () => {
    const bundle = await resolvedBundle("my-skill", "Do the work.");
    const input = { actor: actor(), idempotencyKey: "install-1", bundle };

    const first = await repository.install(input);
    const replay = await repository.install(input);

    expect(first.idempotentReplay).toBe(false);
    expect(replay).toMatchObject({
      idempotentReplay: true,
      installation: { id: first.installation.id, name: "my-skill", enabled: true },
    });
    expect(first.installation.bundle.files).toEqual([
      { path: "SKILL.md", executable: false, sizeBytes: bundle.files[0]!.content.length },
      { path: "references/data.bin", executable: true, sizeBytes: 4 },
    ]);

    const rows = await database.query<{
      bundles: number;
      installations: number;
      files: number;
      bytes_match: boolean;
      executable: boolean;
    }>(`
      SELECT
        (SELECT COUNT(*)::int FROM goat.skill_bundles) AS bundles,
        (SELECT COUNT(*)::int FROM goat.skill_installations) AS installations,
        COUNT(*)::int AS files,
        bool_and(octet_length(content) = size_bytes) AS bytes_match,
        bool_or(executable) AS executable
      FROM goat.skill_bundle_files
    `);
    expect(rows.rows[0]).toEqual({
      bundles: 1,
      installations: 1,
      files: 2,
      bytes_match: true,
      executable: true,
    });
  });

  it("returns a collision without leaving the losing bundle behind", async () => {
    await repository.install({
      actor: actor(),
      idempotencyKey: "install-a",
      bundle: await resolvedBundle("my-skill", "First version."),
    });

    await expect(
      repository.install({
        actor: actor(),
        idempotencyKey: "install-b",
        bundle: await resolvedBundle("my-skill", "Conflicting version."),
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await expect(
      database.query<{ bundles: number; installations: number }>(`
        SELECT
          (SELECT COUNT(*)::int FROM goat.skill_bundles) AS bundles,
          (SELECT COUNT(*)::int FROM goat.skill_installations) AS installations
      `),
    ).resolves.toMatchObject({ rows: [{ bundles: 1, installations: 1 }] });
  });

  it("moves the installation pointer on replacement and never edits old bundles", async () => {
    const first = await repository.install({
      actor: actor(),
      idempotencyKey: "install-a",
      bundle: await resolvedBundle("my-skill", "First version."),
    });
    const second = await repository.replace({
      actor: actor(),
      name: "my-skill",
      bundle: await resolvedBundle("my-skill", "Second version."),
    });

    expect(second.bundle.id).not.toBe(first.installation.bundle.id);
    expect(second.bundle.body).toBe("Second version.");
    await expect(
      database.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM goat.skill_bundles"),
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });

  it("validates workspace ownership on installation and file reads", async () => {
    await repository.install({
      actor: actor(),
      idempotencyKey: "install-a",
      bundle: await resolvedBundle("my-skill", "Workspace one."),
    });

    await expect(
      repository.get({ actor: actor({ workspaceId: "workspace_2" }), name: "my-skill" }),
    ).resolves.toBeNull();
    await expect(
      repository.readFile({
        actor: actor({ workspaceId: "workspace_2" }),
        name: "my-skill",
        path: "SKILL.md",
      }),
    ).resolves.toBeNull();
    const file = await repository.readFile({
      actor: actor(),
      name: "my-skill",
      path: "references/data.bin",
    });
    expect(file).toMatchObject({ executable: true, sizeBytes: 4 });
    expect([...file!.content]).toEqual([0, 255, 1, 2]);
  });
});

async function resolvedBundle(name: string, body: string): Promise<ResolvedSkillBundle> {
  const encoder = new TextEncoder();
  const files = [
    {
      path: "SKILL.md",
      content: encoder.encode(`---\nname: ${name}\ndescription: Test skill.\n---\n${body}`),
      executable: false,
    },
    {
      path: "references/data.bin",
      content: Uint8Array.of(0, 255, 1, 2),
      executable: true,
    },
  ];
  return {
    name,
    description: "Test skill.",
    body,
    source: {
      type: "github",
      url: "https://github.com/example/skills",
      path: name,
      ref: "main",
      resolvedCommit: "a".repeat(40),
    },
    integrity: await computeArtifactIntegrity(files),
    files,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.content.length, 0),
  };
}

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_1",
    workspaceId: "workspace_1",
    role: "admin",
    permissions: ["skill:read", "skill:write"],
    authenticationMethod: "session",
    ...overrides,
  };
}
