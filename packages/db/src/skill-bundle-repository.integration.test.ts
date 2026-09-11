import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { computeArtifactIntegrity, createWorkspaceSkillArtifact } from "@opencompany/agent-runtime";
import type { Actor, ResolvedSkillBundle } from "@opencompany/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activateAndListChatSkillBundles,
  loadImmutableSkillBundles,
  PostgresSkillBundleRepository,
  readChatSkillBundleFile,
} from "./skill-bundle-repository";
import { createTestPGlite } from "./test-pglite";

describe("Postgres immutable Skill bundle repository", () => {
  let database: PGlite;
  let repository: PostgresSkillBundleRepository;

  beforeAll(async () => {
    database = await createTestPGlite();
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.workspaces (id text PRIMARY KEY);
      CREATE TABLE goat.chat_sessions (id text PRIMARY KEY, user_workos_id text NOT NULL DEFAULT 'user_1');
      CREATE TABLE goat.workspace_members (workspace_id text, user_workos_id text, role text);
      INSERT INTO goat.workspace_members VALUES ('workspace_1', 'user_1', 'admin'), ('workspace_1', 'member_a', 'member'), ('workspace_1', 'member_b', 'member'), ('workspace_2', 'user_1', 'admin');
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
        "drizzle/0226_goat_immutable_skill_bundles.sql",
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
        "drizzle/0227_goat_chat_skill_bundle_snapshots.sql",
      ),
      "utf8",
    );
    for (const statement of snapshotMigration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
    const pluginMigration = await readFile(
      path.resolve(import.meta.dirname, "../../..", "drizzle/0228_goat_plugins.sql"),
      "utf8",
    );
    for (const statement of pluginMigration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
    const nameMigration = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../..",
        "drizzle/0229_goat_chat_skill_bundle_names.sql",
      ),
      "utf8",
    );
    for (const statement of nameMigration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
    const workspaceAuthoringMigration = await readFile(
      path.resolve(import.meta.dirname, "../../..", "drizzle/0232_workspace_authored_skills.sql"),
      "utf8",
    );
    for (const statement of workspaceAuthoringMigration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
    const scopeMigration = await readFile(
      path.resolve(import.meta.dirname, "../../..", "drizzle/0263_personal_company_skills.sql"),
      "utf8",
    );
    for (const statement of scopeMigration.split("--> statement-breakpoint"))
      if (statement.trim()) await database.exec(statement);
    await database.exec(`
      ALTER TABLE goat.plugins ADD COLUMN owner_user_id text;
      DROP INDEX goat.plugins_workspace_live_name_idx;
      CREATE UNIQUE INDEX plugins_workspace_live_name_idx ON goat.plugins (workspace_id, owner_user_id, name) WHERE status <> 'archived';
      ALTER TABLE goat.workspace_plugin_data ADD COLUMN owner_user_id text NOT NULL DEFAULT 'user_1';
      ALTER TABLE goat.workspace_plugin_data DROP CONSTRAINT goat_workspace_plugin_data_workspace_id_plugin_name_pk;
      ALTER TABLE goat.workspace_plugin_data ADD PRIMARY KEY (workspace_id, owner_user_id, plugin_name);
    `);
    repository = new PostgresSkillBundleRepository(drizzle(database));
  });

  beforeEach(async () => {
    await database.exec(`
      DELETE FROM goat.chat_session_skill_bundles;
      DELETE FROM goat.chat_messages;
      DELETE FROM goat.chat_sessions;
      DELETE FROM goat.skill_installations;
      DELETE FROM goat.skill_bundles;
      UPDATE goat.skill_scope_rollout
      SET personal_enabled = true, activated_at = now(), activated_release = 'test'
      WHERE id = 'personal_skills';
    `);
  });

  afterAll(async () => {
    await database.close();
  });

  it("keeps old writers Company-scoped until every Personal-skill reader is deployed", async () => {
    await database.exec(`
      UPDATE goat.skill_scope_rollout
      SET personal_enabled = false, activated_at = NULL, activated_release = NULL
      WHERE id = 'personal_skills';
    `);
    const company = await repository.install({
      actor: actor(),
      idempotencyKey: "rollout-company-default",
      bundle: await resolvedBundle("rollout-company", "Still shared during rollout."),
    });
    expect(company.installation.scope).toBe("company");

    await database.query(
      `INSERT INTO goat.skill_installations (id, workspace_id, name, bundle_id)
       VALUES ('legacy_writer', 'workspace_1', 'legacy-writer', $1)`,
      [company.installation.bundle.id],
    );
    expect(
      (
        await database.query<{ scope: string }>(
          "SELECT scope FROM goat.skill_installations WHERE id = 'legacy_writer'",
        )
      ).rows[0]?.scope,
    ).toBe("company");
    expect(
      (
        await database.query<{ company_shared: boolean }>(
          "SELECT company_shared FROM goat.skill_installation_versions WHERE installation_id = 'legacy_writer'",
        )
      ).rows,
    ).toEqual([{ company_shared: true }]);

    await expect(
      repository.install({
        actor: actor(),
        scope: "personal",
        idempotencyKey: "rollout-personal-rejected",
        bundle: await resolvedBundle("rollout-private", "Not writable yet."),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      repository.setScope({
        actor: actor(),
        name: company.installation.id,
        scope: "personal",
        expectedScope: "company",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await database.exec(`
      UPDATE goat.skill_scope_rollout
      SET personal_enabled = true, activated_at = now(), activated_release = 'release_sha'
      WHERE id = 'personal_skills';
    `);
    await expect(
      repository.install({
        actor: actor(),
        idempotencyKey: "rollout-personal-default",
        bundle: await resolvedBundle("rollout-private", "Now private."),
      }),
    ).resolves.toMatchObject({ installation: { scope: "personal" } });
  });

  it("makes member-created Personal skills private across reads, files, catalogs, and bundle loads", async () => {
    const owner = actor({ userId: "member_a", role: "member" });
    const { installation } = await repository.install({
      actor: owner,
      idempotencyKey: "private",
      bundle: await resolvedBundle("private-method", "Private instructions."),
    });
    expect(installation).toMatchObject({
      scope: "personal",
      createdByUserId: "member_a",
      canEdit: true,
      canManage: true,
    });
    for (const other of [actor(), actor({ userId: "member_b", role: "member" })]) {
      expect(await repository.list({ actor: other })).toEqual([]);
      expect(await repository.listCatalog({ actor: other })).toEqual([]);
      for (const name of [installation.id, installation.name]) {
        expect(await repository.get({ actor: other, name })).toBeNull();
        expect(await repository.readFile({ actor: other, name, path: "SKILL.md" })).toBeNull();
        await expect(
          repository.setEnabled({ actor: other, name, enabled: false }),
        ).rejects.toMatchObject({ code: "not_found" });
        await expect(repository.archive({ actor: other, name })).rejects.toMatchObject({
          code: "not_found",
        });
      }
      await expect(
        loadImmutableSkillBundles(drizzle(database), {
          workspaceId: owner.workspaceId,
          userId: other.userId,
          bundleIds: [installation.bundle.id],
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(
      loadImmutableSkillBundles(drizzle(database), {
        workspaceId: owner.workspaceId,
        bundleIds: [installation.bundle.id],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("lets every member edit Company skills while only creators and admins manage visibility and archiving", async () => {
    const owner = actor({ userId: "member_a", role: "member" });
    const teammate = actor({ userId: "member_b", role: "member" });
    const { installation } = await repository.install({
      actor: owner,
      scope: "company",
      idempotencyKey: "company",
      bundle: await resolvedBundle("team-method", "Original."),
    });
    expect(await repository.get({ actor: teammate, name: installation.id })).toMatchObject({
      canEdit: true,
      canManage: false,
    });
    const edited = await repository.replace({
      actor: teammate,
      name: installation.id,
      expectedBundleId: installation.bundle.id,
      bundle: await resolvedBundle("team-method", "Teammate edit."),
    });
    expect(edited).toMatchObject({
      id: installation.id,
      createdByUserId: owner.userId,
      bundle: { body: "Teammate edit." },
    });
    await expect(
      repository.setEnabled({ actor: teammate, name: installation.id, enabled: false }),
    ).resolves.toMatchObject({ enabled: false });
    await expect(
      repository.setScope({
        actor: teammate,
        name: installation.id,
        scope: "personal",
        expectedScope: "company",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      repository.archive({ actor: teammate, name: installation.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await repository.archive({ actor: actor(), name: installation.id });
    expect(await repository.get({ actor: owner, name: installation.id })).toBeNull();
  });

  it("shares the same item and only the published revision, then returns it to its creator", async () => {
    const owner = actor({ userId: "member_a", role: "member" });
    const { installation } = await repository.install({
      actor: owner,
      idempotencyKey: "share",
      bundle: await resolvedBundle("method", "Private draft."),
    });
    const current = await repository.replace({
      actor: owner,
      name: installation.id,
      bundle: await resolvedBundle("method", "Ready to share."),
    });
    const shared = await repository.setScope({
      actor: owner,
      name: installation.id,
      expectedScope: "personal",
      scope: "company",
    });
    expect(shared).toMatchObject({
      id: installation.id,
      scope: "company",
      createdByUserId: owner.userId,
      bundle: { id: current.bundle.id },
    });
    expect(shared.bundle.files.length).toBeGreaterThan(0);
    expect(await repository.get({ actor: actor(), name: installation.id })).toMatchObject({
      bundle: { body: "Ready to share." },
    });
    await expect(
      loadImmutableSkillBundles(drizzle(database), {
        workspaceId: owner.workspaceId,
        userId: "member_b",
        bundleIds: [installation.bundle.id],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      repository.setScope({
        actor: owner,
        name: installation.id,
        expectedScope: "personal",
        scope: "company",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const returned = await repository.setScope({
      actor: actor(),
      name: installation.id,
      expectedScope: "company",
      scope: "personal",
    });
    expect(returned).toMatchObject({
      createdByUserId: owner.userId,
      canEdit: false,
      canManage: false,
    });
    expect(await repository.get({ actor: actor(), name: installation.id })).toBeNull();
    expect(await repository.get({ actor: owner, name: installation.id })).toMatchObject({
      scope: "personal",
    });
  });

  it("separates identical names by person and scope, and resolves visible duplicates only by ID", async () => {
    const owner = actor({ userId: "member_a", role: "member" });
    const teammate = actor({ userId: "member_b", role: "member" });
    const personal = await repository.install({
      actor: owner,
      idempotencyKey: "a",
      bundle: await resolvedBundle("same-name", "A."),
    });
    const other = await repository.install({
      actor: teammate,
      idempotencyKey: "b",
      bundle: await resolvedBundle("same-name", "B."),
    });
    const shared = await repository.install({
      actor: actor(),
      scope: "company",
      idempotencyKey: "c",
      bundle: await resolvedBundle("same-name", "Company."),
    });
    const catalog = await repository.listCatalog({ actor: owner });
    expect(catalog.map((skill) => skill.id).sort()).toEqual(
      [personal.installation.id, shared.installation.id].sort(),
    );
    expect(await repository.get({ actor: owner, name: other.installation.id })).toBeNull();
    await expect(repository.get({ actor: owner, name: "same-name" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      repository.setScope({
        actor: owner,
        name: personal.installation.id,
        expectedScope: "personal",
        scope: "company",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await repository.get({ actor: owner, name: personal.installation.id })).toMatchObject({
      scope: "personal",
    });
  });

  it("keeps an already captured Company revision in its owner's chat after it becomes Personal", async () => {
    const owner = actor({ userId: "member_a", role: "member" });
    const { installation } = await repository.install({
      actor: owner,
      scope: "company",
      idempotencyKey: "captured",
      bundle: await resolvedBundle("captured", "Previously shared."),
    });
    await database.exec(
      "INSERT INTO goat.chat_sessions (id, user_workos_id) VALUES ('chat_b', 'member_b'); INSERT INTO goat.chat_messages (id, session_id) VALUES ('message_b', 'chat_b');",
    );
    await activateAndListChatSkillBundles(drizzle(database), {
      workspaceId: owner.workspaceId,
      userId: "member_b",
      chatSessionId: "chat_b",
      activatedMessageId: "message_b",
      bundles: [{ bundleId: installation.bundle.id, sourceKind: "standalone" }],
    });
    await repository.setScope({
      actor: owner,
      name: installation.id,
      expectedScope: "company",
      scope: "personal",
    });
    const captured = {
      workspaceId: owner.workspaceId,
      userId: "member_b",
      chatSessionId: "chat_b",
      bundleIds: [installation.bundle.id],
    };
    await expect(loadImmutableSkillBundles(drizzle(database), captured)).resolves.toHaveLength(1);
    await expect(
      loadImmutableSkillBundles(drizzle(database), { ...captured, userId: "user_1" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      loadImmutableSkillBundles(drizzle(database), {
        workspaceId: captured.workspaceId,
        userId: captured.userId,
        bundleIds: captured.bundleIds,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    // Returning to Personal also removes the definition from future workflow preparation.
    await expect(
      loadImmutableSkillBundles(drizzle(database), {
        workspaceId: owner.workspaceId,
        bundleIds: [installation.bundle.id],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("excludes the owner's Personal skills from shared Task tool access", async () => {
    const owner = actor({ userId: "member_a", role: "member" });
    const taskActor = { ...owner, skillAccess: "company" as const };
    const { installation } = await repository.install({
      actor: owner,
      idempotencyKey: "task-private",
      bundle: await resolvedBundle("task-private", "Private instructions."),
    });
    expect(await repository.listCatalog({ actor: taskActor })).toEqual([]);
    expect(await repository.get({ actor: taskActor, name: installation.id })).toBeNull();
    await expect(
      repository.install({
        actor: taskActor,
        idempotencyKey: "new-private",
        bundle: await resolvedBundle("new-private", "Private."),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      repository.replace({
        actor: taskActor,
        name: installation.id,
        bundle: await resolvedBundle("task-private", "Edit."),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      loadImmutableSkillBundles(drizzle(database), {
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        skillAccess: "company",
        bundleIds: [installation.bundle.id],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      repository.install({
        actor: taskActor,
        scope: "company",
        idempotencyKey: "task-company",
        bundle: await resolvedBundle("task-company", "Shared."),
      }),
    ).resolves.toMatchObject({ installation: { scope: "company" } });
  });

  it("allows another current member to use Company skills in trusted shared Task contexts", async () => {
    const { installation } = await repository.install({
      actor: actor(),
      scope: "company",
      idempotencyKey: "shared-task",
      bundle: await resolvedBundle("shared-task", "Team instructions."),
    });
    await database.exec(
      "INSERT INTO goat.chat_sessions (id) VALUES ('shared_task'); INSERT INTO goat.chat_messages (id, session_id) VALUES ('shared_message', 'shared_task');",
    );
    await expect(
      activateAndListChatSkillBundles(drizzle(database), {
        workspaceId: "workspace_1",
        userId: "member_b",
        skillAccess: "company",
        chatSessionId: "shared_task",
        activatedMessageId: "shared_message",
        bundles: [{ bundleId: installation.bundle.id, sourceKind: "standalone" }],
      }),
    ).resolves.toHaveLength(1);
  });

  it("rejects a different same-name skill after a Chat has pinned its selection", async () => {
    const owner = actor();
    const personal = await repository.install({
      actor: owner,
      idempotencyKey: "pin-personal",
      bundle: await resolvedBundle("same", "Personal."),
    });
    const company = await repository.install({
      actor: owner,
      scope: "company",
      idempotencyKey: "pin-company",
      bundle: await resolvedBundle("same", "Company."),
    });
    await database.exec(
      "INSERT INTO goat.chat_sessions (id) VALUES ('chat_same'); INSERT INTO goat.chat_messages (id, session_id) VALUES ('message_same', 'chat_same');",
    );
    const target = {
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      chatSessionId: "chat_same",
      activatedMessageId: "message_same",
    };
    await activateAndListChatSkillBundles(drizzle(database), {
      ...target,
      bundles: [{ bundleId: personal.installation.bundle.id, sourceKind: "standalone" }],
    });
    await expect(
      activateAndListChatSkillBundles(drizzle(database), {
        ...target,
        bundles: [{ bundleId: company.installation.bundle.id, sourceKind: "standalone" }],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("lets an admin adopt a legacy Company skill only when making it Personal", async () => {
    const { installation } = await repository.install({
      actor: actor(),
      scope: "company",
      idempotencyKey: "legacy",
      bundle: await resolvedBundle("legacy", "Existing shared instructions."),
    });
    await database.query(
      "UPDATE goat.skill_installations SET created_by_user_id = NULL WHERE id = $1",
      [installation.id],
    );
    await expect(
      repository.setScope({
        actor: actor(),
        name: installation.id,
        scope: "company",
        expectedScope: "company",
      }),
    ).resolves.toMatchObject({ createdByUserId: null });
    await expect(
      repository.setScope({
        actor: actor(),
        name: installation.id,
        scope: "personal",
        expectedScope: "company",
      }),
    ).resolves.toMatchObject({ createdByUserId: "user_1", scope: "personal", canManage: true });
  });

  it("rejects removed members even when their actor still carries an admin role", async () => {
    const stale = actor({ userId: "removed_admin" });
    await expect(
      repository.install({
        actor: stale,
        idempotencyKey: "removed",
        bundle: await resolvedBundle("removed", "No access."),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await repository.list({ actor: stale })).toEqual([]);
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

  it("renames workspace Skills atomically while keeping IDs and captured versions", async () => {
    const original = await createWorkspaceSkillArtifact({
      name: "my-skill",
      description: "Description.",
      instructions: "Original steps.",
    });
    const first = await repository.install({
      actor: actor(),
      idempotencyKey: "rename",
      bundle: original,
    });
    await database.exec(`
      INSERT INTO goat.chat_sessions (id) VALUES ('chat_1');
      INSERT INTO goat.chat_messages (id, session_id) VALUES ('message_1', 'chat_1');
    `);
    const db = drizzle(database);
    await activateAndListChatSkillBundles(db, {
      workspaceId: "workspace_1",
      userId: "user_1",
      chatSessionId: "chat_1",
      activatedMessageId: "message_1",
      bundles: [{ bundleId: first.installation.bundle.id, sourceKind: "standalone" }],
    });
    const renamedBundle = await createWorkspaceSkillArtifact({
      name: "renamed-skill",
      description: original.description,
      instructions: original.body,
    });
    const renamed = await repository.replace({
      actor: actor(),
      name: first.installation.id,
      bundle: renamedBundle,
      expectedBundleId: first.installation.bundle.id,
    });
    expect(renamed).toMatchObject({
      id: first.installation.id,
      name: "renamed-skill",
      scope: first.installation.scope,
      bundle: { name: "renamed-skill", body: original.body },
    });
    expect(renamed.bundle.id).not.toBe(first.installation.bundle.id);
    expect(await repository.get({ actor: actor(), name: "my-skill" })).toBeNull();
    expect(await repository.get({ actor: actor(), name: "renamed-skill" })).toMatchObject({
      id: first.installation.id,
    });
    expect(
      await loadImmutableSkillBundles(db, {
        workspaceId: "workspace_1",
        userId: "user_1",
        bundleIds: [first.installation.bundle.id],
      }),
    ).toMatchObject([{ name: "my-skill", body: original.body }]);
    const captured = await readChatSkillBundleFile(db, {
      workspaceId: "workspace_1",
      userId: "user_1",
      chatSessionId: "chat_1",
      skillName: "my-skill",
      path: "SKILL.md",
    });
    expect(new TextDecoder().decode(captured!.content)).toContain("name: my-skill");
    await expect(
      repository.replace({
        actor: actor(),
        name: first.installation.id,
        bundle: renamedBundle,
        expectedBundleId: first.installation.bundle.id,
      }),
    ).resolves.toMatchObject({ bundle: { id: renamed.bundle.id } });
    await expect(
      repository.replace({
        actor: actor(),
        name: first.installation.id,
        bundle: original,
        expectedBundleId: first.installation.bundle.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await repository.install({
      actor: actor(),
      idempotencyKey: "occupied",
      bundle: await createWorkspaceSkillArtifact({
        name: "occupied",
        description: "Other.",
        instructions: "Other steps.",
      }),
    });
    await expect(
      repository.replace({
        actor: actor(),
        name: renamed.id,
        bundle: await createWorkspaceSkillArtifact({
          name: "occupied",
          description: original.description,
          instructions: original.body,
        }),
        expectedBundleId: renamed.bundle.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await repository.get({ actor: actor(), name: renamed.id })).toMatchObject({
      name: "renamed-skill",
      bundle: { id: renamed.bundle.id },
    });
  });

  it("does not rename imported Skills on refresh", async () => {
    const first = await repository.install({
      actor: actor(),
      idempotencyKey: "imported",
      bundle: await resolvedBundle("my-skill", "Steps."),
    });
    await expect(
      repository.replace({
        actor: actor(),
        name: first.installation.id,
        bundle: await resolvedBundle("renamed-skill", "Steps."),
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("rejects stale edits and permits a retry of an already saved version", async () => {
    const first = await repository.install({
      actor: actor(),
      idempotencyKey: "stale-edit",
      bundle: await resolvedBundle("my-skill", "First."),
    });
    const secondBundle = await resolvedBundle("my-skill", "Second.");
    const second = await repository.replace({
      actor: actor(),
      name: "my-skill",
      bundle: secondBundle,
      expectedBundleId: first.installation.bundle.id,
    });
    await expect(
      repository.replace({
        actor: actor(),
        name: "my-skill",
        bundle: await resolvedBundle("my-skill", "Stale overwrite."),
        expectedBundleId: first.installation.bundle.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      repository.replace({
        actor: actor(),
        name: "my-skill",
        bundle: secondBundle,
        expectedBundleId: first.installation.bundle.id,
      }),
    ).resolves.toMatchObject({ bundle: { id: second.bundle.id } });
    expect((await repository.get({ actor: actor(), name: "my-skill" }))?.bundle.body).toBe(
      secondBundle.body,
    );
  });

  it("stores workspace provenance without fabricating remote source metadata", async () => {
    const bundle = await createWorkspaceSkillArtifact({
      name: "investigate-bug",
      description: "Reproduce and diagnose reported bugs.",
      instructions: "Reproduce the issue first.",
    });
    const installed = await repository.install({
      actor: actor(),
      idempotencyKey: "workspace-author-1",
      bundle,
    });

    expect(installed.installation.bundle.source).toEqual({ type: "workspace" });
    await expect(repository.listCatalog({ actor: actor() })).resolves.toEqual([
      {
        id: installed.installation.id,
        scope: "personal",
        name: "investigate-bug",
        description: "Reproduce and diagnose reported bugs.",
      },
    ]);
    await expect(
      database.query<{
        source_type: string;
        source_url: string | null;
        source_path: string | null;
        source_ref: string | null;
        resolved_commit: string | null;
      }>(
        "SELECT source_type, source_url, source_path, source_ref, resolved_commit FROM goat.skill_bundles",
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          source_type: "workspace",
          source_url: null,
          source_path: null,
          source_ref: null,
          resolved_commit: null,
        },
      ],
    });
  });

  it("keeps workspace and imported provenance distinct for identical bundle contents", async () => {
    const workspaceBundle = await createWorkspaceSkillArtifact({
      name: "investigate-bug",
      description: "Reproduce and diagnose reported bugs.",
      instructions: "Reproduce the issue first.",
    });
    const importedBundle: ResolvedSkillBundle = {
      ...workspaceBundle,
      source: {
        type: "github",
        url: "https://github.com/example/skills",
        path: "investigate-bug",
        ref: "main",
        resolvedCommit: "a".repeat(40),
      },
    };
    const imported = await repository.install({
      actor: actor(),
      idempotencyKey: "identical-imported",
      bundle: importedBundle,
    });
    await repository.archive({ actor: actor(), name: "investigate-bug" });

    const authored = await repository.install({
      actor: actor(),
      idempotencyKey: "identical-workspace",
      bundle: workspaceBundle,
    });

    expect(authored.installation.bundle.id).not.toBe(imported.installation.bundle.id);
    expect(authored.installation.bundle.source).toEqual({ type: "workspace" });
    await expect(
      database.query<{ source_type: string }>(
        "SELECT source_type FROM goat.skill_bundles ORDER BY source_type",
      ),
    ).resolves.toMatchObject({ rows: [{ source_type: "github" }, { source_type: "workspace" }] });
  });

  it("does not convert an imported Skill into a workspace-authored Skill", async () => {
    await repository.install({
      actor: actor(),
      idempotencyKey: "install-imported",
      bundle: await resolvedBundle("my-skill", "Imported version."),
    });

    await expect(
      repository.replace({
        actor: actor(),
        name: "my-skill",
        bundle: await createWorkspaceSkillArtifact({
          name: "my-skill",
          description: "A workspace-authored replacement.",
          instructions: "Workspace-authored instructions.",
        }),
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await expect(repository.get({ actor: actor(), name: "my-skill" })).resolves.toMatchObject({
      bundle: { body: "Imported version.", source: { type: "github" } },
    });
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
      userId: "user_1",
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
      userId: "user_1",
      chatSessionId: "chat_1",
      activatedMessageId: "message_2",
      bundles: [{ bundleId: replacement.bundle.id, sourceKind: "standalone" }],
    });
    const taskBundles = await loadImmutableSkillBundles(db, {
      workspaceId: "workspace_1",
      userId: "user_1",
      bundleIds: taskBundleIds,
    });
    const snapshottedBinary = await readChatSkillBundleFile(db, {
      workspaceId: "workspace_1",
      userId: "user_1",
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
        userId: "user_1",
        chatSessionId: "chat_1",
        activatedMessageId: "message_1",
        bundles: [{ bundleId: first.installation.bundle.id, sourceKind: "standalone" }],
      }),
      activateAndListChatSkillBundles(db, {
        workspaceId: "workspace_1",
        userId: "user_1",
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

describe("Personal and Company skill migration", () => {
  it("keeps legacy active and archived installations Company-scoped with shared revision history", async () => {
    const legacy = await createTestPGlite();
    try {
      await legacy.exec(
        "CREATE SCHEMA goat; CREATE TABLE goat.workspaces (id text PRIMARY KEY); INSERT INTO goat.workspaces VALUES ('legacy_workspace');",
      );
      const migrate = async (name: string) => {
        const migration = await readFile(
          path.resolve(import.meta.dirname, "../../..", "drizzle", name),
          "utf8",
        );
        for (const statement of migration.split("--> statement-breakpoint"))
          if (statement.trim()) await legacy.exec(statement);
      };
      await migrate("0226_goat_immutable_skill_bundles.sql");
      await migrate("0232_workspace_authored_skills.sql");
      await legacy.exec(`
        INSERT INTO goat.skill_bundles (id, workspace_id, integrity, name, description, body, source_type)
        VALUES ('legacy_old', 'legacy_workspace', 'sha256:${"a".repeat(64)}', 'legacy', 'Old', 'Old instructions', 'workspace'),
               ('legacy_current', 'legacy_workspace', 'sha256:${"b".repeat(64)}', 'legacy', 'Current', 'Current instructions', 'workspace');
        INSERT INTO goat.skill_installations (id, workspace_id, name, bundle_id, archived_at)
        VALUES ('archived', 'legacy_workspace', 'legacy', 'legacy_old', now()),
               ('active', 'legacy_workspace', 'legacy', 'legacy_current', null);
      `);
      await migrate("0263_personal_company_skills.sql");
      expect(
        (
          await legacy.query(
            "SELECT id, scope, created_by_user_id FROM goat.skill_installations ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { id: "active", scope: "company", created_by_user_id: null },
        { id: "archived", scope: "company", created_by_user_id: null },
      ]);
      expect(
        (await legacy.query("SELECT company_shared FROM goat.skill_installation_versions")).rows,
      ).toEqual(Array.from({ length: 4 }, () => ({ company_shared: true })));
      expect(
        (
          await legacy.query(
            "SELECT personal_enabled, activated_at, activated_release FROM goat.skill_scope_rollout",
          )
        ).rows,
      ).toEqual([{ personal_enabled: false, activated_at: null, activated_release: null }]);
      await legacy.exec(
        "INSERT INTO goat.skill_installations (id, workspace_id, name, bundle_id, created_by_user_id) VALUES ('new', 'legacy_workspace', 'new-legacy', 'legacy_current', 'creator');",
      );
      expect(
        (await legacy.query("SELECT scope FROM goat.skill_installations WHERE id = 'new'")).rows,
      ).toEqual([{ scope: "company" }]);
      expect(
        (
          await legacy.query(
            "SELECT company_shared FROM goat.skill_installation_versions WHERE installation_id = 'new'",
          )
        ).rows,
      ).toEqual([{ company_shared: true }]);
      await legacy.exec(
        "UPDATE goat.skill_installations SET bundle_id = 'legacy_old' WHERE id = 'new'",
      );
      expect(
        (
          await legacy.query(
            "SELECT company_shared FROM goat.skill_installation_versions WHERE installation_id = 'new' ORDER BY bundle_id",
          )
        ).rows,
      ).toEqual([{ company_shared: true }, { company_shared: true }]);
    } finally {
      await legacy.close();
    }
  });
});
