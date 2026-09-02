import { createHash } from "node:crypto";
import {
  assertSafeRelativePath,
  computeArtifactIntegrity,
  parseSkillDirectoryDocument,
  SKILL_LIMITS,
} from "@opencompany/agent-runtime";
import {
  CoreError,
  type InstalledSkillCatalogItem,
  type ResolvedSkillBundle,
  type SkillBundle,
  type SkillBundleFile,
  type SkillBundleFileMetadata,
  type SkillBundleRepository,
  type SkillInstallation,
  type SkillInstallationListItem,
} from "@opencompany/core";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { loadEnabledPluginSkillBundleIds } from "./plugin-skill-runtime-status";
import {
  type ChatSessionSkillBundleSourceKind,
  chatMessages,
  chatSessionSkillBundles,
  chatSessions,
  pluginSkills,
  plugins,
  skillBundleFiles,
  skillBundles,
  skillInstallations,
} from "./product-schema";
import { type ResolvedWorkspaceSkill, resolveWorkspaceSkillCatalog } from "./skill-catalog";

type DbClient = any;

export type ImmutableSkillBundle = {
  id: string;
  name: string;
  description: string;
  body: string;
  files: SkillBundleFile[];
};

export type ChatSkillBundleActivation = {
  bundleId: string;
  name: string;
  description: string;
  body: string;
  chatSessionId: string;
  activatedMessageId: string;
  sourceKind: ChatSessionSkillBundleSourceKind;
};

type InstallationRow = {
  installationId: string;
  installationWorkspaceId: string;
  installationName: string;
  enabled: boolean;
  archivedAt: Date | null;
  installationCreatedAt: Date;
  installationUpdatedAt: Date;
  bundleId: string;
  integrity: string;
  bundleName: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string> | null;
  allowedTools: string | null;
  body: string;
  sourceType: "github" | "skills.sh" | "workspace";
  sourceUrl: string | null;
  sourcePath: string | null;
  sourceRef: string | null;
  resolvedCommit: string | null;
  bundleCreatedAt: Date;
};

const installationSelection = {
  installationId: skillInstallations.id,
  installationWorkspaceId: skillInstallations.workspaceId,
  installationName: skillInstallations.name,
  enabled: skillInstallations.enabled,
  archivedAt: skillInstallations.archivedAt,
  installationCreatedAt: skillInstallations.createdAt,
  installationUpdatedAt: skillInstallations.updatedAt,
  bundleId: skillBundles.id,
  integrity: skillBundles.integrity,
  bundleName: skillBundles.name,
  description: skillBundles.description,
  license: skillBundles.license,
  compatibility: skillBundles.compatibility,
  metadata: skillBundles.metadata,
  allowedTools: skillBundles.allowedTools,
  body: skillBundles.body,
  sourceType: skillBundles.sourceType,
  sourceUrl: skillBundles.sourceUrl,
  sourcePath: skillBundles.sourcePath,
  sourceRef: skillBundles.sourceRef,
  resolvedCommit: skillBundles.resolvedCommit,
  bundleCreatedAt: skillBundles.createdAt,
} as const;

export class PostgresSkillBundleRepository implements SkillBundleRepository {
  constructor(private readonly db: DbClient) {}

  async install(input: {
    actor: Parameters<SkillBundleRepository["install"]>[0]["actor"];
    idempotencyKey: string;
    bundle: ResolvedSkillBundle;
  }) {
    const installationId = deterministicId(
      "skill_installation",
      input.actor.userId,
      input.actor.workspaceId,
      input.idempotencyKey,
    );
    try {
      return await this.db.transaction(async (tx: DbClient) => {
        const bundleId = await storeSkillBundle(tx, input.actor.workspaceId, input.bundle);
        const replay = await installationById(tx, input.actor.workspaceId, installationId);
        if (replay) {
          if (replay.installationName !== input.bundle.name || replay.bundleId !== bundleId) {
            throw new CoreError(
              "idempotency_conflict",
              "The Idempotency-Key was already used for another Skill installation.",
            );
          }
          return {
            installation: await hydrateInstallation(tx, replay),
            idempotentReplay: true,
          };
        }

        await tx.insert(skillInstallations).values({
          id: installationId,
          workspaceId: input.actor.workspaceId,
          name: input.bundle.name,
          bundleId,
          enabled: true,
        });
        const created = await installationById(tx, input.actor.workspaceId, installationId);
        if (!created) throw new CoreError("conflict", "Could not install the Skill.");
        return {
          installation: await hydrateInstallation(tx, created),
          idempotentReplay: false,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replay = await installationById(this.db, input.actor.workspaceId, installationId);
        if (
          replay?.installationName === input.bundle.name &&
          replay.integrity === input.bundle.integrity
        ) {
          return {
            installation: await hydrateInstallation(this.db, replay),
            idempotentReplay: true,
          };
        }
      }
      throw skillWriteError(error, input.bundle.name);
    }
  }

  async replace(input: {
    actor: Parameters<SkillBundleRepository["replace"]>[0]["actor"];
    name: string;
    bundle: ResolvedSkillBundle;
  }) {
    if (input.bundle.name !== input.name) {
      throw new CoreError(
        "invalid_argument",
        "A replacement Skill bundle must keep the installed Skill name.",
      );
    }
    try {
      return await this.db.transaction(async (tx: DbClient) => {
        const current = await liveInstallation(tx, input.actor.workspaceId, input.name);
        if (!current) throw new CoreError("not_found", "Skill not found.");
        if ((current.sourceType === "workspace") !== (input.bundle.source.type === "workspace")) {
          throw new CoreError(
            "conflict",
            "A Skill cannot change between an imported and workspace-authored source.",
          );
        }
        const bundleId = await storeSkillBundle(tx, input.actor.workspaceId, input.bundle);
        const [updated] = await tx
          .update(skillInstallations)
          .set({ bundleId, updatedAt: new Date() })
          .where(
            and(
              eq(skillInstallations.id, current.installationId),
              eq(skillInstallations.workspaceId, input.actor.workspaceId),
              isNull(skillInstallations.archivedAt),
            ),
          )
          .returning({ id: skillInstallations.id });
        if (!updated) throw new CoreError("not_found", "Skill not found.");
        const row = await installationById(tx, input.actor.workspaceId, updated.id);
        if (!row) throw new CoreError("not_found", "Skill not found.");
        return hydrateInstallation(tx, row);
      });
    } catch (error) {
      throw skillWriteError(error, input.name);
    }
  }

  async list(input: { actor: Parameters<SkillBundleRepository["list"]>[0]["actor"] }) {
    const rows = (await installationQuery(this.db)
      .where(
        and(
          eq(skillInstallations.workspaceId, input.actor.workspaceId),
          eq(skillBundles.workspaceId, input.actor.workspaceId),
          isNull(skillInstallations.archivedAt),
        ),
      )
      .orderBy(desc(skillInstallations.updatedAt))) as InstallationRow[];
    return rows.map(listItem);
  }

  async listCatalog(input: {
    actor: Parameters<SkillBundleRepository["listCatalog"]>[0]["actor"];
  }): Promise<InstalledSkillCatalogItem[]> {
    const catalog = await resolveWorkspaceSkillCatalog(this.db, {
      workspaceId: input.actor.workspaceId,
    });
    return catalog.skills.map(({ id, name, description }) => ({ id, name, description }));
  }

  async get(input: { actor: Parameters<SkillBundleRepository["get"]>[0]["actor"]; name: string }) {
    const standalone = await liveInstallation(this.db, input.actor.workspaceId, input.name);
    if (standalone) {
      // Disabled standalone installations remain inspectable in Settings even though they are not
      // catalog candidates and therefore do not hide an enabled Plugin Skill.
      return hydrateInstallation(this.db, standalone);
    }

    const resolved = await resolvedSkillByName(this.db, input.actor.workspaceId, input.name);
    if (resolved?.sourceKind === "plugin") {
      return hydratePluginSkillInstallation(this.db, input.actor.workspaceId, resolved);
    }
    return null;
  }

  async readFile(input: {
    actor: Parameters<SkillBundleRepository["readFile"]>[0]["actor"];
    name: string;
    path: string;
  }): Promise<SkillBundleFile | null> {
    assertSafeStoredPath(input.path);
    const resolved = await resolvedSkillByName(this.db, input.actor.workspaceId, input.name);
    const fallbackInstallation = resolved
      ? null
      : await liveInstallation(this.db, input.actor.workspaceId, input.name);
    const bundleId = resolved?.bundleId ?? fallbackInstallation?.bundleId;
    if (!bundleId) return null;
    const [row] = await this.db
      .select({
        path: skillBundleFiles.path,
        content: skillBundleFiles.content,
        executable: skillBundleFiles.executable,
        sizeBytes: skillBundleFiles.sizeBytes,
      })
      .from(skillBundles)
      .innerJoin(
        skillBundleFiles,
        and(eq(skillBundleFiles.bundleId, bundleId), eq(skillBundleFiles.path, input.path)),
      )
      .where(
        and(eq(skillBundles.workspaceId, input.actor.workspaceId), eq(skillBundles.id, bundleId)),
      )
      .limit(1);
    return row
      ? {
          path: row.path,
          content: new Uint8Array(row.content),
          executable: row.executable,
          sizeBytes: row.sizeBytes,
        }
      : null;
  }

  async setEnabled(input: {
    actor: Parameters<SkillBundleRepository["setEnabled"]>[0]["actor"];
    name: string;
    enabled: boolean;
  }) {
    const [updated] = await this.db
      .update(skillInstallations)
      .set({ enabled: input.enabled, updatedAt: new Date() })
      .where(
        and(
          eq(skillInstallations.workspaceId, input.actor.workspaceId),
          eq(skillInstallations.name, input.name),
          isNull(skillInstallations.archivedAt),
        ),
      )
      .returning({ id: skillInstallations.id });
    if (!updated) throw new CoreError("not_found", "Skill not found.");
    const row = await installationById(this.db, input.actor.workspaceId, updated.id);
    if (!row) throw new CoreError("not_found", "Skill not found.");
    return hydrateInstallation(this.db, row);
  }

  async archive(input: {
    actor: Parameters<SkillBundleRepository["archive"]>[0]["actor"];
    name: string;
  }) {
    const now = new Date();
    const rows = await this.db
      .update(skillInstallations)
      .set({ enabled: false, archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(skillInstallations.workspaceId, input.actor.workspaceId),
          eq(skillInstallations.name, input.name),
          isNull(skillInstallations.archivedAt),
        ),
      )
      .returning({ id: skillInstallations.id });
    if (rows.length === 0) throw new CoreError("not_found", "Skill not found.");
  }
}

export async function activateAndListChatSkillBundles(
  db: DbClient,
  input: {
    workspaceId: string;
    chatSessionId: string;
    activatedMessageId: string;
    bundles: Array<{ bundleId: string; sourceKind: ChatSessionSkillBundleSourceKind }>;
  },
): Promise<ChatSkillBundleActivation[]> {
  return db.transaction(async (tx: DbClient) => {
    // Keep host-tool calls serialized per Chat. The unique Chat/name key also arbitrates with the
    // create-message activation path, which does not take this row lock.
    const [activationTarget] = await tx
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .innerJoin(
        chatMessages,
        and(
          eq(chatMessages.id, input.activatedMessageId),
          eq(chatMessages.sessionId, chatSessions.id),
        ),
      )
      .where(eq(chatSessions.id, input.chatSessionId))
      .limit(1)
      .for("update");
    if (!activationTarget) {
      throw new CoreError("not_found", "The Chat skill activation target was not found.");
    }

    const requestedById = new Map(input.bundles.map((bundle) => [bundle.bundleId, bundle]));
    const requestedIds = [...requestedById.keys()];
    if (requestedIds.length > 0) {
      const candidates = await tx
        .select({ id: skillBundles.id, name: skillBundles.name })
        .from(skillBundles)
        .where(
          and(
            eq(skillBundles.workspaceId, input.workspaceId),
            inArray(skillBundles.id, requestedIds),
          ),
        );
      if (candidates.length !== requestedIds.length) {
        throw new CoreError("not_found", "A Skill bundle is unavailable in this workspace.");
      }

      const candidatesById = new Map<string, { id: string; name: string }>(
        candidates.map(
          (candidate: { id: string; name: string }) => [candidate.id, candidate] as const,
        ),
      );
      const newNames = new Set<string>();
      const values = requestedIds.flatMap((candidateId) => {
        const candidate = candidatesById.get(candidateId)!;
        if (newNames.has(candidate.name)) return [];
        newNames.add(candidate.name);
        const requested = requestedById.get(candidateId)!;
        return [
          {
            chatSessionId: input.chatSessionId,
            bundleId: candidateId,
            name: candidate.name,
            activatedMessageId: input.activatedMessageId,
            sourceKind: requested.sourceKind,
          },
        ];
      });
      if (values.length > 0) {
        await tx
          .insert(chatSessionSkillBundles)
          .values(values)
          .onConflictDoNothing({
            target: [chatSessionSkillBundles.chatSessionId, chatSessionSkillBundles.name],
          });
      }
    }

    // Re-read after conflict arbitration so callers receive whichever bundle first fixed the name.
    return listChatSkillBundleActivations(tx, {
      workspaceId: input.workspaceId,
      chatSessionId: input.chatSessionId,
    });
  });
}

export async function listChatSkillBundleActivations(
  db: DbClient,
  input: { workspaceId: string; chatSessionId: string },
): Promise<ChatSkillBundleActivation[]> {
  const activations = (await db
    .select({
      bundleId: chatSessionSkillBundles.bundleId,
      chatSessionId: chatSessionSkillBundles.chatSessionId,
      activatedMessageId: chatSessionSkillBundles.activatedMessageId,
      sourceKind: chatSessionSkillBundles.sourceKind,
      name: skillBundles.name,
      description: skillBundles.description,
      body: skillBundles.body,
    })
    .from(chatSessionSkillBundles)
    .innerJoin(skillBundles, eq(skillBundles.id, chatSessionSkillBundles.bundleId))
    .where(
      and(
        eq(chatSessionSkillBundles.chatSessionId, input.chatSessionId),
        eq(skillBundles.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(asc(skillBundles.name))) as ChatSkillBundleActivation[];
  if (!activations.some((activation) => activation.sourceKind === "plugin")) {
    return activations;
  }
  const enabledPluginBundleIds = await loadEnabledPluginSkillBundleIds(db, {
    workspaceId: input.workspaceId,
    bundleIds: activations.flatMap((activation) =>
      activation.sourceKind === "plugin" ? [activation.bundleId] : [],
    ),
  });
  return activations.filter(
    (activation) =>
      activation.sourceKind === "standalone" || enabledPluginBundleIds.has(activation.bundleId),
  );
}

export async function loadImmutableSkillBundles(
  db: DbClient,
  input: { workspaceId: string; bundleIds: readonly string[] },
): Promise<ImmutableSkillBundle[]> {
  const bundleIds = [...new Set(input.bundleIds)];
  if (bundleIds.length === 0) return [];
  const rows = await db
    .select({
      id: skillBundles.id,
      name: skillBundles.name,
      description: skillBundles.description,
      body: skillBundles.body,
      path: skillBundleFiles.path,
      content: skillBundleFiles.content,
      executable: skillBundleFiles.executable,
      sizeBytes: skillBundleFiles.sizeBytes,
    })
    .from(skillBundles)
    .innerJoin(skillBundleFiles, eq(skillBundleFiles.bundleId, skillBundles.id))
    .where(
      and(eq(skillBundles.workspaceId, input.workspaceId), inArray(skillBundles.id, bundleIds)),
    )
    .orderBy(asc(skillBundles.name), asc(skillBundleFiles.path));

  const bundles = new Map<string, ImmutableSkillBundle>();
  for (const row of rows as Array<{
    id: string;
    name: string;
    description: string;
    body: string;
    path: string;
    content: Uint8Array;
    executable: boolean;
    sizeBytes: number;
  }>) {
    const bundle = bundles.get(row.id) ?? {
      id: row.id,
      name: row.name,
      description: row.description,
      body: row.body,
      files: [],
    };
    bundle.files.push({
      path: row.path,
      content: new Uint8Array(row.content),
      executable: row.executable,
      sizeBytes: row.sizeBytes,
    });
    bundles.set(row.id, bundle);
  }
  if (bundles.size !== bundleIds.length) {
    throw new CoreError("not_found", "A Skill bundle snapshot is unavailable.");
  }
  return bundleIds.map((id) => bundles.get(id)!);
}

export async function readChatSkillBundleFile(
  db: DbClient,
  input: { workspaceId: string; chatSessionId: string; skillName: string; path: string },
): Promise<SkillBundleFile | null> {
  assertSafeStoredPath(input.path);
  const [row] = await db
    .select({
      bundleId: chatSessionSkillBundles.bundleId,
      sourceKind: chatSessionSkillBundles.sourceKind,
      path: skillBundleFiles.path,
      content: skillBundleFiles.content,
      executable: skillBundleFiles.executable,
      sizeBytes: skillBundleFiles.sizeBytes,
    })
    .from(chatSessionSkillBundles)
    .innerJoin(skillBundles, eq(skillBundles.id, chatSessionSkillBundles.bundleId))
    .innerJoin(
      skillBundleFiles,
      and(
        eq(skillBundleFiles.bundleId, chatSessionSkillBundles.bundleId),
        eq(skillBundleFiles.path, input.path),
      ),
    )
    .where(
      and(
        eq(chatSessionSkillBundles.chatSessionId, input.chatSessionId),
        eq(skillBundles.workspaceId, input.workspaceId),
        eq(skillBundles.name, input.skillName),
      ),
    )
    .limit(1);
  if (row?.sourceKind === "plugin") {
    const enabledPluginBundleIds = await loadEnabledPluginSkillBundleIds(db, {
      workspaceId: input.workspaceId,
      bundleIds: [row.bundleId],
    });
    if (!enabledPluginBundleIds.has(row.bundleId)) return null;
  }
  return row
    ? {
        path: row.path,
        content: new Uint8Array(row.content),
        executable: row.executable,
        sizeBytes: row.sizeBytes,
      }
    : null;
}

export async function storeSkillBundle(
  db: DbClient,
  workspaceId: string,
  bundle: ResolvedSkillBundle,
) {
  validateResolvedBundle(bundle);
  const recomputed = await computeArtifactIntegrity(bundle.files);
  if (recomputed !== bundle.integrity) {
    throw new CoreError(
      "conflict",
      "The Skill bundle changed before it could be stored. Preview it again.",
    );
  }

  const existing = await bundleByIdentity(db, workspaceId, bundle.integrity, bundle.source.type);
  if (existing) return existing.id;

  const id = deterministicId("skill_bundle", workspaceId, bundle.integrity, bundle.source.type);
  const [created] = await db
    .insert(skillBundles)
    .values({
      id,
      workspaceId,
      integrity: bundle.integrity,
      name: bundle.name,
      description: bundle.description,
      license: bundle.license ?? null,
      compatibility: bundle.compatibility ?? null,
      metadata: bundle.metadata ?? null,
      allowedTools: bundle.allowedTools ?? null,
      body: bundle.body,
      sourceType: bundle.source.type,
      sourceUrl: bundle.source.type === "workspace" ? null : bundle.source.url,
      sourcePath: bundle.source.type === "workspace" ? null : bundle.source.path,
      sourceRef: bundle.source.type === "workspace" ? null : bundle.source.ref,
      resolvedCommit: bundle.source.type === "workspace" ? null : bundle.source.resolvedCommit,
    })
    .onConflictDoNothing({
      target: [skillBundles.workspaceId, skillBundles.integrity, skillBundles.sourceType],
    })
    .returning({ id: skillBundles.id });

  if (created) {
    await db.insert(skillBundleFiles).values(
      bundle.files.map((file) => ({
        bundleId: created.id,
        path: file.path,
        content: Buffer.from(file.content),
        executable: file.executable,
        sizeBytes: file.content.length,
      })),
    );
    return created.id;
  }
  const winner = await bundleByIdentity(db, workspaceId, bundle.integrity, bundle.source.type);
  if (!winner) throw new CoreError("conflict", "Could not store the Skill bundle.");
  return winner.id;
}

function installationQuery(db: DbClient) {
  return db
    .select(installationSelection)
    .from(skillInstallations)
    .innerJoin(
      skillBundles,
      and(
        eq(skillBundles.id, skillInstallations.bundleId),
        eq(skillBundles.workspaceId, skillInstallations.workspaceId),
      ),
    );
}

async function installationById(db: DbClient, workspaceId: string, id: string) {
  const [row] = (await installationQuery(db)
    .where(
      and(
        eq(skillInstallations.id, id),
        eq(skillInstallations.workspaceId, workspaceId),
        eq(skillBundles.workspaceId, workspaceId),
      ),
    )
    .limit(1)) as InstallationRow[];
  return row ?? null;
}

async function liveInstallation(db: DbClient, workspaceId: string, name: string) {
  const [row] = (await installationQuery(db)
    .where(
      and(
        eq(skillInstallations.workspaceId, workspaceId),
        eq(skillBundles.workspaceId, workspaceId),
        eq(skillInstallations.name, name),
        isNull(skillInstallations.archivedAt),
      ),
    )
    .limit(1)) as InstallationRow[];
  return row ?? null;
}

async function resolvedSkillByName(db: DbClient, workspaceId: string, name: string) {
  const catalog = await resolveWorkspaceSkillCatalog(db, { workspaceId });
  return catalog.skills.find((skill) => skill.id === name) ?? null;
}

async function hydratePluginSkillInstallation(
  db: DbClient,
  workspaceId: string,
  skill: ResolvedWorkspaceSkill,
): Promise<SkillInstallation | null> {
  if (!skill.pluginId || !skill.pluginName) return null;
  const [row] = (await db
    .select({
      installationWorkspaceId: pluginSkills.workspaceId,
      installationCreatedAt: plugins.createdAt,
      installationUpdatedAt: plugins.updatedAt,
      bundleId: skillBundles.id,
      integrity: skillBundles.integrity,
      bundleName: skillBundles.name,
      description: skillBundles.description,
      license: skillBundles.license,
      compatibility: skillBundles.compatibility,
      metadata: skillBundles.metadata,
      allowedTools: skillBundles.allowedTools,
      body: skillBundles.body,
      sourceType: skillBundles.sourceType,
      sourceUrl: skillBundles.sourceUrl,
      sourcePath: skillBundles.sourcePath,
      sourceRef: skillBundles.sourceRef,
      resolvedCommit: skillBundles.resolvedCommit,
      bundleCreatedAt: skillBundles.createdAt,
    })
    .from(pluginSkills)
    .innerJoin(
      plugins,
      and(eq(plugins.id, pluginSkills.pluginId), eq(plugins.workspaceId, pluginSkills.workspaceId)),
    )
    .innerJoin(
      skillBundles,
      and(
        eq(skillBundles.id, pluginSkills.skillBundleId),
        eq(skillBundles.workspaceId, pluginSkills.workspaceId),
      ),
    )
    .where(
      and(
        eq(pluginSkills.workspaceId, workspaceId),
        eq(pluginSkills.pluginId, skill.pluginId),
        eq(pluginSkills.skillName, skill.name),
        eq(pluginSkills.skillBundleId, skill.bundleId),
        eq(plugins.status, "enabled"),
      ),
    )
    .limit(1)) as Array<
    Omit<InstallationRow, "installationId" | "installationName" | "enabled" | "archivedAt">
  >;
  if (!row) return null;
  return hydrateInstallation(db, {
    ...row,
    installationId: `plugin_skill:${skill.pluginId}:${skill.name}`,
    installationName: skill.name,
    enabled: true,
    archivedAt: null,
  });
}

async function bundleByIdentity(
  db: DbClient,
  workspaceId: string,
  integrity: string,
  sourceType: ResolvedSkillBundle["source"]["type"],
) {
  const [row] = await db
    .select({ id: skillBundles.id })
    .from(skillBundles)
    .where(
      and(
        eq(skillBundles.workspaceId, workspaceId),
        eq(skillBundles.integrity, integrity),
        eq(skillBundles.sourceType, sourceType),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function hydrateInstallation(db: DbClient, row: InstallationRow): Promise<SkillInstallation> {
  const files = (await db
    .select({
      path: skillBundleFiles.path,
      executable: skillBundleFiles.executable,
      sizeBytes: skillBundleFiles.sizeBytes,
    })
    .from(skillBundleFiles)
    .innerJoin(skillBundles, eq(skillBundles.id, skillBundleFiles.bundleId))
    .where(
      and(
        eq(skillBundleFiles.bundleId, row.bundleId),
        eq(skillBundles.workspaceId, row.installationWorkspaceId),
      ),
    )
    .orderBy(asc(skillBundleFiles.path))) as SkillBundleFileMetadata[];
  return installation(row, files);
}

function installation(row: InstallationRow, files: SkillBundleFileMetadata[]): SkillInstallation {
  return {
    id: row.installationId,
    name: row.installationName,
    enabled: row.enabled,
    archivedAt: row.archivedAt,
    createdAt: row.installationCreatedAt,
    updatedAt: row.installationUpdatedAt,
    bundle: bundle(row, files),
  };
}

function listItem(row: InstallationRow): SkillInstallationListItem {
  return {
    id: row.installationId,
    name: row.installationName,
    enabled: row.enabled,
    archivedAt: row.archivedAt,
    updatedAt: row.installationUpdatedAt,
    bundle: {
      id: row.bundleId,
      integrity: row.integrity,
      name: row.bundleName,
      description: row.description,
      license: row.license,
      compatibility: row.compatibility,
      metadata: row.metadata,
      allowedTools: row.allowedTools,
      source: bundleSource(row),
      createdAt: row.bundleCreatedAt,
    },
  };
}

function bundle(row: InstallationRow, files: SkillBundleFileMetadata[]): SkillBundle {
  return {
    id: row.bundleId,
    integrity: row.integrity,
    name: row.bundleName,
    description: row.description,
    license: row.license,
    compatibility: row.compatibility,
    metadata: row.metadata,
    allowedTools: row.allowedTools,
    body: row.body,
    source: bundleSource(row),
    files,
    createdAt: row.bundleCreatedAt,
  };
}

function validateResolvedBundle(bundle: ResolvedSkillBundle) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(bundle.integrity)) {
    throw new CoreError("invalid_argument", "The Skill bundle integrity is invalid.");
  }
  if (bundle.source.type !== "workspace" && !/^[0-9a-f]{40}$/u.test(bundle.source.resolvedCommit)) {
    throw new CoreError("invalid_argument", "The Skill source commit is invalid.");
  }
  if (bundle.source.type !== "workspace" && bundle.source.path) {
    assertSafeStoredPath(bundle.source.path);
  }
  if (bundle.files.length === 0 || bundle.files.length > SKILL_LIMITS.maxFileCount) {
    throw new CoreError("invalid_argument", "The Skill bundle has an invalid file count.");
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of bundle.files) {
    assertSafeStoredPath(file.path);
    if (paths.has(file.path)) {
      throw new CoreError("invalid_argument", `Duplicate Skill file path: ${file.path}.`);
    }
    paths.add(file.path);
    if (file.content.length > SKILL_LIMITS.maxFileBytes) {
      throw new CoreError("invalid_argument", `Skill file ${file.path} is too large.`);
    }
    totalBytes += file.content.length;
  }
  if (!paths.has("SKILL.md") || totalBytes > SKILL_LIMITS.maxTotalBytes) {
    throw new CoreError("invalid_argument", "The Skill bundle is incomplete or too large.");
  }
  if (bundle.fileCount !== bundle.files.length || bundle.totalBytes !== totalBytes) {
    throw new CoreError("invalid_argument", "The Skill bundle metadata does not match its files.");
  }

  const skillFile = bundle.files.find((file) => file.path === "SKILL.md");
  if (!skillFile) throw new CoreError("invalid_argument", "The Skill bundle is incomplete.");
  try {
    const parsed = parseSkillDirectoryDocument(
      new TextDecoder("utf-8", { fatal: true }).decode(skillFile.content),
      bundle.name,
    );
    if (
      parsed.frontmatter.name !== bundle.name ||
      parsed.frontmatter.description !== bundle.description ||
      parsed.frontmatter.license !== bundle.license ||
      parsed.frontmatter.compatibility !== bundle.compatibility ||
      parsed.frontmatter.allowedTools !== bundle.allowedTools ||
      !sameMetadata(parsed.frontmatter.metadata, bundle.metadata) ||
      parsed.body !== bundle.body
    ) {
      throw new CoreError(
        "invalid_argument",
        "The Skill bundle fields do not match its SKILL.md file.",
      );
    }
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError(
      "invalid_argument",
      error instanceof Error ? error.message : "The Skill bundle is invalid.",
    );
  }
}

function sameMetadata(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
) {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function requiredSourceValue(value: string | null): string {
  if (value === null) throw new CoreError("conflict", "The Skill source metadata is incomplete.");
  return value;
}

function bundleSource(row: InstallationRow): SkillBundle["source"] {
  return row.sourceType === "workspace"
    ? { type: "workspace" }
    : {
        type: row.sourceType,
        url: requiredSourceValue(row.sourceUrl),
        path: requiredSourceValue(row.sourcePath),
        ref: requiredSourceValue(row.sourceRef),
        resolvedCommit: requiredSourceValue(row.resolvedCommit),
      };
}

function assertSafeStoredPath(path: string) {
  try {
    assertSafeRelativePath(path);
  } catch (error) {
    throw new CoreError(
      "invalid_argument",
      error instanceof Error ? error.message : "The Skill file path is invalid.",
    );
  }
}

function deterministicId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32)}`;
}

function skillWriteError(error: unknown, name: string) {
  if (error instanceof CoreError) return error;
  if (isUniqueViolation(error)) {
    return new CoreError(
      "conflict",
      `A live Skill named ${JSON.stringify(name)} is already installed in this workspace.`,
    );
  }
  return error;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: unknown };
  return value.code === "23505" || isUniqueViolation(value.cause);
}
