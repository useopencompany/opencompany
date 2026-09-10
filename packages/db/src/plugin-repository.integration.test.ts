import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { computeArtifactIntegrity } from "@opencompany/agent-runtime";
import type { Actor, ResolvedPluginPackage, ResolvedSkillBundle } from "@opencompany/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listActivePluginGatewayRegistrations,
  storePluginGatewayDiscoveryFailure,
  storePluginGatewayDiscoverySnapshot,
} from "./plugin-gateway-repository";
import { PostgresPluginRepository } from "./plugin-repository";
import { loadChatSessionPluginRuntime } from "./plugin-runtime-repository";
import { PostgresSkillBundleRepository } from "./skill-bundle-repository";

describe("Postgres immutable Plugin repository", () => {
  let database: PGlite;
  let db: ReturnType<typeof drizzle>;
  let repository: PostgresPluginRepository;
  let skillRepository: PostgresSkillBundleRepository;
  const deletePluginDataBlob = vi.fn(async () => undefined);

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.plugin_ownership_rollout (id text PRIMARY KEY, personal_enabled boolean NOT NULL);
      INSERT INTO goat.plugin_ownership_rollout VALUES ('personal_plugins', true);
      CREATE TABLE goat.workspaces (id text PRIMARY KEY);
      CREATE TABLE goat.chat_sessions (id text PRIMARY KEY);
      CREATE TABLE goat.workspace_members (workspace_id text, user_workos_id text, role text);
      INSERT INTO goat.workspace_members VALUES ('workspace_1', 'user_1', 'admin'), ('workspace_2', 'user_1', 'admin');
      CREATE TABLE goat.integrations (id text PRIMARY KEY);
      INSERT INTO goat.workspaces (id) VALUES ('workspace_1'), ('workspace_2');
      INSERT INTO goat.chat_sessions (id) VALUES ('chat_1');
    `);
    for (const migrationName of [
      "0226_goat_immutable_skill_bundles.sql",
      "0228_goat_plugins.sql",
      "0232_workspace_authored_skills.sql",
      "0234_goat_plugin_gateway_registrations.sql",
      "0263_personal_company_skills.sql",
    ]) {
      const migration = await readFile(
        path.resolve(import.meta.dirname, "../../..", `drizzle/${migrationName}`),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await database.exec(statement);
      }
    }
    await database.exec(`
      ALTER TABLE goat.plugins ADD COLUMN events jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE goat.plugins ADD COLUMN event_modes jsonb NOT NULL DEFAULT '{}'::jsonb;
    `);
    await database.exec(`
      ALTER TABLE goat.plugins ADD COLUMN owner_user_id text;
      DROP INDEX goat.plugins_workspace_live_name_idx;
      CREATE UNIQUE INDEX plugins_workspace_live_name_idx ON goat.plugins (workspace_id, owner_user_id, name) WHERE status <> 'archived';
      ALTER TABLE goat.workspace_plugin_data ADD COLUMN owner_user_id text NOT NULL DEFAULT 'user_1';
      ALTER TABLE goat.workspace_plugin_data DROP CONSTRAINT goat_workspace_plugin_data_workspace_id_plugin_name_pk;
      ALTER TABLE goat.workspace_plugin_data ADD PRIMARY KEY (workspace_id, owner_user_id, plugin_name);
    `);
    db = drizzle(database);
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
      DELETE FROM goat.plugin_gateway_registrations;
      DELETE FROM goat.integrations;
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

  it("isolates two members' installations, events, discovery, saved data, and pinned runtime", async () => {
    await database.exec(
      "INSERT INTO goat.workspace_members VALUES ('workspace_1', 'user_2', 'member')",
    );
    const alice = actor();
    const bob = actor({ userId: "user_2", role: "member" });
    const plugin = await resolvedPlugin("linear", "review", "Personal review.", {
      events: true,
      mcp: true,
      remoteMcp: true,
    });
    const first = await repository.install({ actor: alice, plugin, idempotencyKey: "same-key" });
    expect(await repository.list({ actor: bob })).toEqual([]);
    expect(await repository.get({ actor: bob, name: "linear" })).toBeNull();
    await expect(
      repository.setStatus({ actor: bob, name: "linear", status: "disabled" }),
    ).rejects.toMatchObject({ code: "not_found" });
    const second = await repository.install({ actor: bob, plugin, idempotencyKey: "same-key" });
    expect(second.plugin.id).not.toBe(first.plugin.id);
    expect((await repository.list({ actor: alice })).map((p) => p.id)).toEqual([first.plugin.id]);
    expect((await repository.list({ actor: bob })).map((p) => p.id)).toEqual([second.plugin.id]);
    await repository.setEventEnabled({
      actor: alice,
      name: "linear",
      eventId: "issue.created",
      enabled: true,
    });
    expect((await repository.get({ actor: bob, name: "linear" }))?.eventModes).toEqual({});
    const [registration] = await listActivePluginGatewayRegistrations(db, alice);
    expect(
      await storePluginGatewayDiscoveryFailure(db, {
        ...bob,
        registrationId: registration!.id,
        error: "Teammate write",
        attemptedAt: new Date(),
        retryAfter: new Date(),
      }),
    ).toBeUndefined();
    expect(
      (await listActivePluginGatewayRegistrations(db, alice))[0]?.lastDiscoveryError,
    ).toBeNull();
    await database.query(
      "INSERT INTO goat.chat_session_plugins (chat_session_id, plugin_id) VALUES ($1, $2)",
      ["chat_1", first.plugin.id],
    );
    expect(await loadChatSessionPluginRuntime(db, { ...bob, chatSessionId: "chat_1" })).toEqual({
      plugins: [],
      skills: [],
      mcpPlugins: [],
    });
    await repository.archive({ actor: alice, name: "linear" });
    expect((await repository.get({ actor: bob, name: "linear" }))?.status).toBe("enabled");
    expect(await skillRepository.listCatalog({ actor: alice })).toEqual([]);
    expect(await skillRepository.listCatalog({ actor: bob })).toHaveLength(1);
    await database.exec("DELETE FROM goat.workspace_members WHERE user_workos_id = 'user_2'");
    expect(await repository.list({ actor: bob })).toEqual([]);
    expect(await listActivePluginGatewayRegistrations(db, bob)).toEqual([]);
    await expect(
      repository.install({ actor: bob, plugin, idempotencyKey: "revoked" }),
    ).rejects.toMatchObject({ code: "not_found" });
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
      { id: "review", name: "review", description: "Review from plugin.", scope: null },
    ]);
    await expect(skillRepository.get({ actor: actor(), name: "review" })).resolves.toMatchObject({
      name: "review",
      enabled: true,
      bundle: { body: "Use review." },
    });
    const file = await skillRepository.readFile({
      actor: actor(),
      name: "review",
      path: "SKILL.md",
    });
    expect(new TextDecoder().decode(file?.content)).toContain("Use review.");
  });

  it("resolves standalone and plugin collisions deterministically and reports every hidden plugin", async () => {
    await repository.install({
      actor: actor(),
      idempotencyKey: "dot",
      plugin: await resolvedPlugin("a.tools", "shared", "From dot."),
    });
    const dash = await repository.install({
      actor: actor(),
      idempotencyKey: "dash",
      plugin: await resolvedPlugin("a-tools", "shared", "From dash."),
    });

    expect(dash.plugin.installReport.collisions).toEqual([
      {
        skillName: "shared",
        winner: { source: "plugin", pluginName: "a-tools" },
        hiddenPluginNames: ["a.tools"],
      },
    ]);
    await expect(skillRepository.listCatalog({ actor: actor() })).resolves.toEqual([
      { id: "shared", name: "shared", description: "From dash.", scope: null },
    ]);

    const standalone = await skillRepository.install({
      scope: "company",
      actor: actor(),
      idempotencyKey: "standalone",
      bundle: await resolvedSkill("shared", "Standalone wins."),
    });
    await expect(skillRepository.listCatalog({ actor: actor() })).resolves.toEqual([
      {
        id: standalone.installation.id,
        name: "shared",
        description: "Standalone wins.",
        scope: "company",
      },
    ]);
    const inspected = await repository.get({ actor: actor(), name: "a-tools" });
    expect(inspected?.installReport.collisions).toEqual([
      {
        skillName: "shared",
        winner: { source: "standalone" },
        hiddenPluginNames: ["a-tools", "a.tools"],
      },
    ]);
    await skillRepository.setEnabled({
      actor: actor(),
      name: "shared",
      enabled: false,
    });
    await expect(skillRepository.listCatalog({ actor: actor() })).resolves.toEqual([
      { id: "shared", name: "shared", description: "From dash.", scope: null },
    ]);
    await expect(skillRepository.get({ actor: actor(), name: "shared" })).resolves.toMatchObject({
      id: standalone.installation.id,
      name: "shared",
      enabled: false,
      bundle: { id: standalone.installation.bundle.id },
    });
  });

  it("loads only snapshotted enabled Plugin IDs and applies the live kill switch", async () => {
    const installed = await repository.install({
      actor: actor(),
      idempotencyKey: "runtime-plugin",
      plugin: await resolvedPlugin("quality-tools", "review", "First runtime version."),
    });
    await database.query(
      "INSERT INTO goat.chat_session_plugins (chat_session_id, plugin_id) VALUES ($1, $2)",
      ["chat_1", installed.plugin.id],
    );
    const db = drizzle(database);

    await expect(
      loadChatSessionPluginRuntime(db, {
        userId: "user_1",
        workspaceId: "workspace_1",
        chatSessionId: "chat_1",
      }),
    ).resolves.toMatchObject({
      plugins: [{ id: installed.plugin.id, name: "quality-tools" }],
      skills: [{ name: "review", body: "Use review." }],
    });

    await repository.setStatus({ actor: actor(), name: "quality-tools", status: "disabled" });
    await expect(
      loadChatSessionPluginRuntime(db, {
        userId: "user_1",
        workspaceId: "workspace_1",
        chatSessionId: "chat_1",
      }),
    ).resolves.toEqual({ plugins: [], skills: [], mcpPlugins: [] });

    await repository.setStatus({ actor: actor(), name: "quality-tools", status: "enabled" });
    await repository.archive({ actor: actor(), name: "quality-tools" });
    const replacement = await repository.install({
      actor: actor(),
      idempotencyKey: "runtime-plugin-replacement",
      plugin: await resolvedPlugin("quality-tools", "review", "Replacement runtime version."),
    });
    expect(replacement.plugin.id).not.toBe(installed.plugin.id);
    await expect(
      loadChatSessionPluginRuntime(db, {
        userId: "user_1",
        workspaceId: "workspace_1",
        chatSessionId: "chat_1",
      }),
    ).resolves.toEqual({ plugins: [], skills: [], mcpPlugins: [] });
  });

  it("starts MCP only for the exact approved package and clears approval on revoke or replacement", async () => {
    const installed = await repository.install({
      actor: actor(),
      idempotencyKey: "mcp-runtime-plugin",
      plugin: await resolvedPlugin("quality-tools", "review", "MCP runtime version.", {
        mcp: true,
      }),
    });
    await database.query(
      "INSERT INTO goat.chat_session_plugins (chat_session_id, plugin_id) VALUES ($1, $2)",
      ["chat_1", installed.plugin.id],
    );
    const db = drizzle(database);

    await expect(
      loadChatSessionPluginRuntime(db, {
        userId: "user_1",
        workspaceId: "workspace_1",
        chatSessionId: "chat_1",
      }),
    ).resolves.toMatchObject({ mcpPlugins: [] });
    await expect(
      repository.approveMcp({
        actor: actor(),
        name: "quality-tools",
        integrity: `sha256:${"f".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const approved = await repository.approveMcp({
      actor: actor(),
      name: "quality-tools",
      integrity: installed.plugin.integrity,
    });
    expect(approved.mcpApprovedIntegrity).toBe(installed.plugin.integrity);
    await expect(
      loadChatSessionPluginRuntime(db, {
        userId: "user_1",
        workspaceId: "workspace_1",
        chatSessionId: "chat_1",
      }),
    ).resolves.toMatchObject({
      mcpPlugins: [
        {
          id: installed.plugin.id,
          name: "quality-tools",
          integrity: installed.plugin.integrity,
          stdioServers: [
            {
              name: "local",
              command: "node",
              args: ["${PLUGIN_ROOT}/server.mjs"],
              cwd: "${PLUGIN_DATA}",
              env: { CACHE_DIR: "${PLUGIN_DATA}/cache", PUBLIC_MODE: "safe" },
              type: "stdio",
            },
          ],
        },
      ],
    });

    const revoked = await repository.revokeMcp({ actor: actor(), name: "quality-tools" });
    expect(revoked.mcpApprovedIntegrity).toBeNull();
    await expect(
      loadChatSessionPluginRuntime(db, {
        userId: "user_1",
        workspaceId: "workspace_1",
        chatSessionId: "chat_1",
      }),
    ).resolves.toMatchObject({ mcpPlugins: [] });

    await repository.approveMcp({
      actor: actor(),
      name: "quality-tools",
      integrity: installed.plugin.integrity,
    });
    await repository.setStatus({
      actor: actor(),
      name: "quality-tools",
      status: "disabled",
    });
    await expect(
      repository.approveMcp({
        actor: actor(),
        name: "quality-tools",
        integrity: installed.plugin.integrity,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "The Plugin is disabled. Enable it before approving MCP.",
    });
    const disabledRevocation = await repository.revokeMcp({
      actor: actor(),
      name: "quality-tools",
    });
    expect(disabledRevocation.mcpApprovedIntegrity).toBeNull();
    await repository.archive({ actor: actor(), name: "quality-tools" });
    const replacement = await repository.install({
      actor: actor(),
      idempotencyKey: "mcp-runtime-plugin-replacement",
      plugin: await resolvedPlugin("quality-tools", "review", "Replacement MCP runtime.", {
        mcp: true,
      }),
    });
    await database.query(
      "UPDATE goat.chat_session_plugins SET plugin_id = $1 WHERE chat_session_id = $2",
      [replacement.plugin.id, "chat_1"],
    );
    expect(replacement.plugin.integrity).not.toBe(installed.plugin.integrity);
    expect(replacement.plugin.mcpApprovedIntegrity).toBeNull();
    await expect(
      loadChatSessionPluginRuntime(db, {
        userId: "user_1",
        workspaceId: "workspace_1",
        chatSessionId: "chat_1",
      }),
    ).resolves.toMatchObject({
      plugins: [{ id: replacement.plugin.id }],
      mcpPlugins: [],
    });
  });

  it("keeps remote MCP endpoint configuration out of sandbox packages", async () => {
    const installed = await repository.install({
      actor: actor(),
      idempotencyKey: "remote-mcp-runtime-plugin",
      plugin: await resolvedPlugin("quality-tools", "review", "Remote MCP runtime.", {
        mcp: true,
        remoteMcp: true,
      }),
    });
    await database.query(
      "INSERT INTO goat.chat_session_plugins (chat_session_id, plugin_id) VALUES ($1, $2)",
      ["chat_1", installed.plugin.id],
    );
    const db = drizzle(database);

    const runtime = await loadChatSessionPluginRuntime(db, {
      userId: "user_1",
      workspaceId: "workspace_1",
      chatSessionId: "chat_1",
    });
    expect(runtime.plugins[0]?.files.map((file: { path: string }) => file.path)).not.toContain(
      "mcp.json",
    );
    expect(installed.plugin.files.map((file: { path: string }) => file.path)).toContain("mcp.json");

    await repository.approveMcp({
      actor: actor(),
      name: "quality-tools",
      integrity: installed.plugin.integrity,
    });
    await expect(
      loadChatSessionPluginRuntime(db, {
        userId: "user_1",
        workspaceId: "workspace_1",
        chatSessionId: "chat_1",
      }),
    ).resolves.toMatchObject({
      mcpPlugins: [
        {
          name: "quality-tools",
          stdioServers: [{ name: "local", type: "stdio", command: "node" }],
        },
      ],
    });
  });

  it("persists gateway registration and snapshot lifecycle without deleting connection modes", async () => {
    const installed = await repository.install({
      actor: actor(),
      idempotencyKey: "linear-gateway",
      plugin: await resolvedPlugin("linear", "review", "Linear gateway.", {
        mcp: true,
        remoteMcp: true,
        capabilities: true,
      }),
    });
    await database.exec(`
      INSERT INTO goat.integrations (id, tool_modes)
      VALUES ('gint_linear_1', '{"new_tool":"on"}'::jsonb)
    `);

    const [registration] = await listActivePluginGatewayRegistrations(db, {
      userId: "user_1",
      workspaceId: "workspace_1",
      pluginName: "linear",
    });
    expect(registration).toMatchObject({
      pluginId: installed.plugin.id,
      pluginName: "linear",
      connectionProvider: "linear",
      server: {
        name: "remote",
        type: "streamable-http",
        url: "https://mcp.example.com/private-endpoint",
      },
      capabilities: [
        { id: "read", label: "Read Linear", defaultMode: "on", tools: ["list_issues"] },
        { id: "write", label: "Manage issues", defaultMode: "ask", tools: ["save_issue"] },
      ],
      discoverySnapshot: [],
      discoveredAt: null,
    });

    const discoveredAt = new Date("2026-08-26T12:00:00.000Z");
    const refreshAfter = new Date("2026-08-26T13:00:00.000Z");
    await storePluginGatewayDiscoverySnapshot(db, {
      userId: "user_1",
      workspaceId: "workspace_1",
      registrationId: registration!.id,
      discoveredAt,
      refreshAfter,
      snapshot: [
        {
          name: "new_tool",
          inputSchema: { type: "object" },
          classification: {
            capabilityId: "write",
            capabilityLabel: "Write & other tools",
            defaultMode: "ask",
            bucket: "write",
            curated: false,
          },
        },
      ],
    });
    await expect(
      listActivePluginGatewayRegistrations(db, {
        userId: "user_1",
        workspaceId: "workspace_1",
        pluginName: "linear",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        discoverySnapshot: [
          expect.objectContaining({
            name: "new_tool",
            classification: expect.objectContaining({ curated: false, defaultMode: "ask" }),
          }),
        ],
        discoveredAt,
        refreshAfter,
      }),
    ]);
    await expect(repository.get({ actor: actor(), name: "linear" })).resolves.toMatchObject({
      remoteMcpServers: [
        {
          name: "remote",
          connectionProvider: "linear",
          discoveryStatus: "ready",
          tools: [expect.objectContaining({ name: "new_tool" })],
          discoveredAt,
          refreshAfter,
          lastDiscoveryError: null,
        },
      ],
    });

    const attemptedAt = new Date("2026-08-26T12:30:00.000Z");
    await storePluginGatewayDiscoveryFailure(db, {
      userId: "user_1",
      workspaceId: "workspace_1",
      registrationId: registration!.id,
      error: "Provider discovery timed out.",
      attemptedAt,
      retryAfter: new Date("2026-08-26T12:35:00.000Z"),
    });
    await expect(repository.get({ actor: actor(), name: "linear" })).resolves.toMatchObject({
      remoteMcpServers: [
        {
          discoveryStatus: "stale",
          tools: [expect.objectContaining({ name: "new_tool" })],
          lastDiscoveryError: "Provider discovery timed out.",
        },
      ],
    });

    await repository.setStatus({ actor: actor(), name: "linear", status: "disabled" });
    await expect(
      listActivePluginGatewayRegistrations(db, { userId: "user_1", workspaceId: "workspace_1" }),
    ).resolves.toEqual([]);
    await expect(
      database.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM goat.plugin_gateway_registrations",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });

    await repository.setStatus({ actor: actor(), name: "linear", status: "enabled" });
    await repository.archive({ actor: actor(), name: "linear" });
    await expect(
      database.query<{ registrations: number; connections: number; tool_mode: string }>(`
        SELECT
          (SELECT COUNT(*)::int FROM goat.plugin_gateway_registrations) AS registrations,
          (SELECT COUNT(*)::int FROM goat.integrations) AS connections,
          (SELECT tool_modes->>'new_tool' FROM goat.integrations WHERE id = 'gint_linear_1') AS tool_mode
      `),
    ).resolves.toMatchObject({
      rows: [{ registrations: 0, connections: 1, tool_mode: "on" }],
    });
  });

  it("archives without deleting immutable rows and makes the live name replaceable", async () => {
    const installed = await repository.install({
      actor: actor(),
      idempotencyKey: "first",
      plugin: await resolvedPlugin("quality-tools", "review", "First.", { events: true }),
    });
    await repository.setEventEnabled({
      actor: actor(),
      name: "quality-tools",
      eventId: "issue.created",
      enabled: true,
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
      plugin: await resolvedPlugin("quality-tools", "review", "Second.", { events: true }),
    });
    expect(replacement.plugin.id).not.toBe(installed.plugin.id);
    expect(replacement.plugin.eventModes).toEqual({ "issue.created": true });
    await expect(
      database.query<{ plugins: number }>("SELECT COUNT(*)::int AS plugins FROM goat.plugins"),
    ).resolves.toMatchObject({ rows: [{ plugins: 2 }] });
  });

  it("deletes archived plugin data rows before their private blobs", async () => {
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
    await repository.archive({ actor: actor(), name: "quality-tools" });
    deletePluginDataBlob.mockImplementationOnce(async () => {
      await expect(
        database.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM goat.workspace_plugin_data WHERE workspace_id = 'workspace_1' AND plugin_name = 'quality-tools'",
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    });
    await expect(repository.deleteData({ actor: actor(), name: "quality-tools" })).resolves.toEqual(
      { deleted: true },
    );
    expect(deletePluginDataBlob).toHaveBeenCalledWith("private/plugins/quality-tools.tar");
    await expect(repository.deleteData({ actor: actor(), name: "quality-tools" })).resolves.toEqual(
      { deleted: false },
    );
  });
});

function pluginEventDeclaration() {
  return {
    id: "issue.created",
    label: "Issue created",
    description: "Starts when an issue is created.",
    delivery: "webhook" as const,
    filters: [
      {
        id: "team",
        label: "Team",
        kind: "integration_resource" as const,
        resourceType: "team",
        required: true,
      },
    ],
  };
}

async function resolvedPlugin(
  pluginName: string,
  skillName: string,
  description: string,
  options: {
    skippedSkill?: boolean;
    mcp?: boolean;
    remoteMcp?: boolean;
    capabilities?: boolean;
    events?: boolean;
  } = {},
): Promise<ResolvedPluginPackage> {
  const skill = await resolvedSkill(skillName, description, `skills/${skillName}`);
  const pluginJson = new TextEncoder().encode(
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: pluginName,
      description: `${pluginName} plugin.`,
      ...(options.capabilities || options.events
        ? {
            extensions: {
              ...(options.capabilities
                ? {
                    "so.opencompany.capabilities": {
                      read: { label: "Read Linear", defaultMode: "on", tools: ["list_issues"] },
                      write: { label: "Manage issues", defaultMode: "ask", tools: ["save_issue"] },
                    },
                  }
                : {}),
              ...(options.events ? { "so.opencompany.events": [pluginEventDeclaration()] } : {}),
            },
          }
        : {}),
    }),
  );
  const mcpJson = new TextEncoder().encode(
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        local: {
          type: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/server.mjs"],
          cwd: "${PLUGIN_DATA}",
          env: { CACHE_DIR: "${PLUGIN_DATA}/cache", PUBLIC_MODE: "safe" },
        },
        ...(options.remoteMcp
          ? {
              remote: {
                type: "streamable-http",
                url: "https://mcp.example.com/private-endpoint",
              },
            }
          : {}),
      },
    }),
  );
  const files = [
    { path: "plugin.json", content: pluginJson, executable: false },
    ...skill.files.map((file) => ({ ...file, path: `skills/${skillName}/${file.path}` })),
    ...(options.mcp
      ? [
          { path: "mcp.json", content: mcpJson, executable: false },
          {
            path: "server.mjs",
            content: new TextEncoder().encode("process.stdin.resume();"),
            executable: false,
          },
        ]
      : []),
  ];
  return {
    manifest: {
      name: pluginName,
      description: `${pluginName} plugin.`,
      ...(options.capabilities || options.events
        ? {
            extensions: {
              ...(options.capabilities
                ? {
                    "so.opencompany.capabilities": {
                      read: { label: "Read Linear", defaultMode: "on", tools: ["list_issues"] },
                      write: { label: "Manage issues", defaultMode: "ask", tools: ["save_issue"] },
                    },
                  }
                : {}),
              ...(options.events ? { "so.opencompany.events": [pluginEventDeclaration()] } : {}),
            },
          }
        : {}),
    },
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
    stdioServers: options.mcp
      ? [
          {
            name: "local",
            type: "stdio",
            command: "node",
            args: ["${PLUGIN_ROOT}/server.mjs"],
            env: { CACHE_DIR: "${PLUGIN_DATA}/cache", PUBLIC_MODE: "safe" },
            cwd: "${PLUGIN_DATA}",
          },
        ]
      : [],
    remoteServers:
      options.mcp && options.remoteMcp
        ? [
            {
              name: "remote",
              type: "streamable-http",
              url: "https://mcp.example.com/private-endpoint",
              headers: {},
            },
          ]
        : [],
    capabilities: options.capabilities
      ? [
          { id: "read", label: "Read Linear", defaultMode: "on", tools: ["list_issues"] },
          { id: "write", label: "Manage issues", defaultMode: "ask", tools: ["save_issue"] },
        ]
      : [],
    events: options.events ? [pluginEventDeclaration()] : [],
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
      mcp: options.mcp
        ? {
            present: true,
            status: "parsed",
            reports: [
              { name: "local", status: "selected", transport: "stdio" },
              ...(options.remoteMcp
                ? [
                    {
                      name: "remote",
                      status: "gateway-registered" as const,
                      transport: "streamable-http" as const,
                    },
                  ]
                : []),
            ],
          }
        : { status: "absent" },
      capabilities: options.capabilities
        ? { present: true, status: "parsed", issues: [] }
        : { status: "absent" },
      events: options.events
        ? { present: true, status: "parsed", issues: [] }
        : { status: "absent" },
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
