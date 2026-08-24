import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { computeArtifactIntegrity } from "@opencompany/agent-runtime";
import type { Actor, ResolvedPluginPackage, ResolvedSkillBundle } from "@opencompany/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresPluginRepository } from "./plugin-repository";
import { PostgresSkillBundleRepository } from "./skill-bundle-repository";

describe("Postgres immutable Plugin repository", () => {
  let database: PGlite;
  let repository: PostgresPluginRepository;
  let skillRepository: PostgresSkillBundleRepository;
  const deletePluginDataBlob = vi.fn(async () => undefined);

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.workspaces (id text PRIMARY KEY);
      CREATE TABLE goat.chat_sessions (id text PRIMARY KEY);
      INSERT INTO goat.workspaces (id) VALUES ('workspace_1'), ('workspace_2');
      INSERT INTO goat.chat_sessions (id) VALUES ('chat_1');
    `);
    for (const migrationName of [
      "0222_goat_immutable_skill_bundles.sql",
      "0224_goat_plugins.sql",
    ]) {
      const migration = await readFile(
        path.resolve(import.meta.dirname, "../../..", `drizzle/${migrationName}`),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await database.exec(statement);
      }
    }
    const db = drizzle(database);
    repository = new PostgresPluginRepository(db, {
      pluginDataStorage: { delete: deletePluginDataBlob },
    });
    skillRepository = new PostgresSkillBundleRepository(db);
  });

  beforeEach(async () => {
    deletePluginDataBlob.mockClear();
    await database.exec(`
      DELETE FROM goat.chat_session_plugins;
      DELETE FROM goat.workspace_plugin_data;
      DELETE FROM goat.plugin_skills;
      DELETE FROM goat.plugin_files;
      DELETE FROM goat.plugins;
      DELETE FROM goat.skill_installations;
      DELETE FROM goat.skill_bundles;
    `);
  });

  afterAll(async () => {
    await database.close();
  });

  it("installs package bytes and valid skill bundles atomically without standalone projection", async () => {
    const plugin = await resolvedPlugin("quality-tools", "review", "Review from plugin.", {
      skippedSkill: true,
    });
    const input = { actor: actor(), idempotencyKey: "plugin-install-1", plugin };

    const first = await repository.install(input);
    const replay = await repository.install(input);

    expect(first.idempotentReplay).toBe(false);
    expect(replay).toMatchObject({
      idempotentReplay: true,
      plugin: { id: first.plugin.id, name: "quality-tools", status: "enabled" },
    });
    expect(first.plugin.skills).toEqual([
      expect.objectContaining({ name: "review", description: "Review from plugin." }),
    ]);
    expect(first.plugin.installReport.skills).toEqual([
      expect.objectContaining({ name: "review", status: "valid" }),
      expect.objectContaining({ name: "broken", status: "skipped" }),
    ]);
    await expect(
      repository.install({
        ...input,
        plugin: {
          ...plugin,
          source: { ...plugin.source, resolvedCommit: "b".repeat(40) },
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      database.query<{
        plugins: number;
        files: number;
        mappings: number;
        bundles: number;
        standalone: number;
        byte_sizes_match: boolean;
      }>(`
        SELECT
          (SELECT COUNT(*)::int FROM goat.plugins) AS plugins,
          (SELECT COUNT(*)::int FROM goat.plugin_files) AS files,
          (SELECT COUNT(*)::int FROM goat.plugin_skills) AS mappings,
          (SELECT COUNT(*)::int FROM goat.skill_bundles) AS bundles,
          (SELECT COUNT(*)::int FROM goat.skill_installations) AS standalone,
          bool_and(octet_length(content) = size_bytes) AS byte_sizes_match
        FROM goat.plugin_files
      `),
    ).resolves.toMatchObject({
      rows: [
        {
          plugins: 1,
          files: 2,
          mappings: 1,
          bundles: 1,
          standalone: 0,
          byte_sizes_match: true,
        },
      ],
    });
    await expect(skillRepository.listCatalog({ actor: actor() })).resolves.toEqual([
      { id: "review", name: "review", description: "Review from plugin." },
    ]);
  });

  it("resolves standalone and plugin collisions deterministically and reports every hidden plugin", async () => {
    await repository.install({
      actor: actor(),
      idempotencyKey: "zeta",
      plugin: await resolvedPlugin("zeta-tools", "shared", "From zeta."),
    });
    const alpha = await repository.install({
      actor: actor(),
      idempotencyKey: "alpha",
      plugin: await resolvedPlugin("alpha-tools", "shared", "From alpha."),
    });

    expect(alpha.plugin.installReport.collisions).toEqual([
      {
        skillName: "shared",
        winner: { source: "plugin", pluginName: "alpha-tools" },
        hiddenPluginNames: ["zeta-tools"],
      },
    ]);
    await expect(skillRepository.listCatalog({ actor: actor() })).resolves.toEqual([
      { id: "shared", name: "shared", description: "From alpha." },
    ]);

    await skillRepository.install({
      actor: actor(),
      idempotencyKey: "standalone",
      bundle: await resolvedSkill("shared", "Standalone wins."),
    });
    await expect(skillRepository.listCatalog({ actor: actor() })).resolves.toEqual([
      { id: "shared", name: "shared", description: "Standalone wins." },
    ]);
    const inspected = await repository.get({ actor: actor(), name: "alpha-tools" });
    expect(inspected?.installReport.collisions).toEqual([
      {
        skillName: "shared",
        winner: { source: "standalone" },
        hiddenPluginNames: ["alpha-tools", "zeta-tools"],
      },
    ]);
  });

  it("archives without deleting immutable rows and makes the live name replaceable", async () => {
    const installed = await repository.install({
      actor: actor(),
      idempotencyKey: "first",
      plugin: await resolvedPlugin("quality-tools", "review", "First."),
    });

    await repository.archive({ actor: actor(), name: "quality-tools" });

    await expect(repository.get({ actor: actor(), name: "quality-tools" })).resolves.toBeNull();
    await expect(
      database.query<{ plugins: number; files: number; mappings: number }>(`
        SELECT
          (SELECT COUNT(*)::int FROM goat.plugins) AS plugins,
          (SELECT COUNT(*)::int FROM goat.plugin_files) AS files,
          (SELECT COUNT(*)::int FROM goat.plugin_skills) AS mappings
      `),
    ).resolves.toMatchObject({ rows: [{ plugins: 1, files: 2, mappings: 1 }] });
    const replacement = await repository.install({
      actor: actor(),
      idempotencyKey: "second",
      plugin: await resolvedPlugin("quality-tools", "review", "Second."),
    });
    expect(replacement.plugin.id).not.toBe(installed.plugin.id);
    await expect(
      database.query<{ plugins: number }>("SELECT COUNT(*)::int AS plugins FROM goat.plugins"),
    ).resolves.toMatchObject({ rows: [{ plugins: 2 }] });
  });

  it("enforces workspace ownership and deletes persistent data separately", async () => {
    await repository.install({
      actor: actor(),
      idempotencyKey: "plugin",
      plugin: await resolvedPlugin("quality-tools", "review", "Review."),
    });
    await database.exec(`
      INSERT INTO goat.workspace_plugin_data (
        workspace_id, plugin_name, blob_pathname, checksum, size_bytes, generation
      ) VALUES (
        'workspace_1', 'quality-tools', 'private/plugins/quality-tools.tar',
        'sha256:${"d".repeat(64)}', 12, 1
      )
    `);

    await expect(
      repository.get({ actor: actor({ workspaceId: "workspace_2" }), name: "quality-tools" }),
    ).resolves.toBeNull();
    await expect(repository.deleteData({ actor: actor(), name: "quality-tools" })).resolves.toEqual(
      { deleted: true },
    );
    expect(deletePluginDataBlob).toHaveBeenCalledWith("private/plugins/quality-tools.tar");
    await expect(repository.deleteData({ actor: actor(), name: "quality-tools" })).resolves.toEqual(
      { deleted: false },
    );
  });
});

async function resolvedPlugin(
  pluginName: string,
  skillName: string,
  description: string,
  options: { skippedSkill?: boolean } = {},
): Promise<ResolvedPluginPackage> {
  const skill = await resolvedSkill(skillName, description, `skills/${skillName}`);
  const pluginJson = new TextEncoder().encode(
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: pluginName,
      description: `${pluginName} plugin.`,
    }),
  );
  const files = [
    { path: "plugin.json", content: pluginJson, executable: false },
    ...skill.files.map((file) => ({ ...file, path: `skills/${skillName}/${file.path}` })),
  ];
  return {
    manifest: { name: pluginName, description: `${pluginName} plugin.` },
    source: {
      type: "github",
      url: "https://github.com/example/plugins",
      path: pluginName,
      ref: "main",
      resolvedCommit: "a".repeat(40),
    },
    integrity: await computeArtifactIntegrity(files),
    files,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.content.length, 0),
    skills: [{ path: `skills/${skillName}`, bundle: skill }],
    stdioServers: [],
    report: {
      ignoredManifestFields: [],
      skills: [
        {
          path: `skills/${skillName}`,
          name: skillName,
          status: "valid",
          integrity: skill.integrity,
        },
        ...(options.skippedSkill
          ? [
              {
                path: "skills/broken",
                name: "broken",
                status: "skipped" as const,
                reason: "Skill name does not match its directory.",
              },
            ]
          : []),
      ],
      mcp: { status: "absent" },
    },
  };
}

async function resolvedSkill(
  name: string,
  description: string,
  sourcePath = name,
): Promise<ResolvedSkillBundle> {
  const content = new TextEncoder().encode(
    `---\nname: ${name}\ndescription: ${description}\n---\nUse ${name}.`,
  );
  const files = [{ path: "SKILL.md", content, executable: false }];
  return {
    name,
    description,
    body: `Use ${name}.`,
    source: {
      type: "github",
      url: "https://github.com/example/plugins",
      path: sourcePath,
      ref: "main",
      resolvedCommit: "a".repeat(40),
    },
    integrity: await computeArtifactIntegrity(files),
    files,
    fileCount: 1,
    totalBytes: content.length,
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
