import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { computeArtifactIntegrity } from "@opencompany/agent-runtime";
import type { Actor, ResolvedSkillBundle } from "@opencompany/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activateAndListChatSkillBundles,
  loadImmutableSkillBundles,
  PostgresSkillBundleRepository,
  readChatSkillBundleFile,
} from "./skill-bundle-repository";

describe("Postgres immutable Skill bundle repository", () => {
  let database: PGlite;
  let repository: PostgresSkillBundleRepository;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.workspaces (id text PRIMARY KEY);
      CREATE TABLE goat.chat_sessions (id text PRIMARY KEY);
      CREATE TABLE goat.chat_messages (
        id text PRIMARY KEY,
        session_id text NOT NULL REFERENCES goat.chat_sessions(id)
      );
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
    const snapshotMigration = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../..",
        "drizzle/0223_goat_chat_skill_bundle_snapshots.sql",
      ),
      "utf8",
    );
    for (const statement of snapshotMigration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
    const pluginMigration = await readFile(
      path.resolve(import.meta.dirname, "../../..", "drizzle/0224_goat_plugins.sql"),
      "utf8",
    );
    for (const statement of pluginMigration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
    const nameMigration = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../..",
        "drizzle/0225_goat_chat_skill_bundle_names.sql",
      ),
      "utf8",
    );
    for (const statement of nameMigration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
    repository = new PostgresSkillBundleRepository(drizzle(database));
  });

  beforeEach(async () => {
    await database.exec(`
      DELETE FROM goat.chat_session_skill_bundles;
      DELETE FROM goat.chat_messages;
      DELETE FROM goat.chat_sessions;
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

  it("keeps Chat and Task bundle IDs immutable after replacement and archive", async () => {
    const first = await repository.install({
      actor: actor(),
      idempotencyKey: "install-a",
      bundle: await resolvedBundle("my-skill", "First version."),
    });
    await database.exec(`
      INSERT INTO goat.chat_sessions (id) VALUES ('chat_1');
      INSERT INTO goat.chat_messages (id, session_id)
      VALUES ('message_1', 'chat_1'), ('message_2', 'chat_1');
    `);
    const db = drizzle(database);
    const firstActivation = await activateAndListChatSkillBundles(db, {
      workspaceId: "workspace_1",
      chatSessionId: "chat_1",
      activatedMessageId: "message_1",
      bundles: [{ bundleId: first.installation.bundle.id, sourceKind: "standalone" }],
    });
    const taskBundleIds = [first.installation.bundle.id];

    const replacement = await repository.replace({
      actor: actor(),
      name: "my-skill",
      bundle: await resolvedBundle("my-skill", "Second version."),
    });
    await repository.archive({ actor: actor(), name: "my-skill" });
    const afterReplacement = await activateAndListChatSkillBundles(db, {
      workspaceId: "workspace_1",
      chatSessionId: "chat_1",
      activatedMessageId: "message_2",
      bundles: [{ bundleId: replacement.bundle.id, sourceKind: "standalone" }],
    });
    const taskBundles = await loadImmutableSkillBundles(db, {
      workspaceId: "workspace_1",
      bundleIds: taskBundleIds,
    });
    const snapshottedBinary = await readChatSkillBundleFile(db, {
      workspaceId: "workspace_1",
      chatSessionId: "chat_1",
      skillName: "my-skill",
      path: "references/data.bin",
    });

    expect(firstActivation).toMatchObject([
      {
        bundleId: first.installation.bundle.id,
        activatedMessageId: "message_1",
        body: "First version.",
      },
    ]);
    expect(afterReplacement).toMatchObject([
      {
        bundleId: first.installation.bundle.id,
        activatedMessageId: "message_1",
        body: "First version.",
      },
    ]);
    expect(taskBundles).toMatchObject([
      { id: first.installation.bundle.id, body: "First version." },
    ]);
    expect(snapshottedBinary).toMatchObject({ executable: true, sizeBytes: 4 });
    expect([...snapshottedBinary!.content]).toEqual([0, 255, 1, 2]);
  });

  it("returns the single winning bundle when same-name versions activate concurrently", async () => {
    const first = await repository.install({
      actor: actor(),
      idempotencyKey: "install-a",
      bundle: await resolvedBundle("my-skill", "First version."),
    });
    const replacement = await repository.replace({
      actor: actor(),
      name: "my-skill",
      bundle: await resolvedBundle("my-skill", "Second version."),
    });
    await database.exec(`
      INSERT INTO goat.chat_sessions (id) VALUES ('chat_1');
      INSERT INTO goat.chat_messages (id, session_id)
      VALUES ('message_1', 'chat_1'), ('message_2', 'chat_1');
    `);
    const db = drizzle(database);

    const activations = await Promise.all([
      activateAndListChatSkillBundles(db, {
        workspaceId: "workspace_1",
        chatSessionId: "chat_1",
        activatedMessageId: "message_1",
        bundles: [{ bundleId: first.installation.bundle.id, sourceKind: "standalone" }],
      }),
      activateAndListChatSkillBundles(db, {
        workspaceId: "workspace_1",
        chatSessionId: "chat_1",
        activatedMessageId: "message_2",
        bundles: [{ bundleId: replacement.bundle.id, sourceKind: "standalone" }],
      }),
    ]);
    const persisted = await database.query<{ bundle_id: string; name: string }>(`
      SELECT bundle_id, name
      FROM goat.chat_session_skill_bundles
      WHERE chat_session_id = 'chat_1'
    `);

    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({ name: "my-skill" });
    expect(activations).toEqual([
      [expect.objectContaining({ bundleId: persisted.rows[0]!.bundle_id, name: "my-skill" })],
      [expect.objectContaining({ bundleId: persisted.rows[0]!.bundle_id, name: "my-skill" })],
    ]);
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
