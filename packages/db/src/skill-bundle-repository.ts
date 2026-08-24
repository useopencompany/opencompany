import { createHash } from "node:crypto";
import {
  assertSafeRelativePath,
  computeArtifactIntegrity,
  parseSkillDocument,
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
import {
  type ChatSessionSkillBundleSourceKind,
  chatMessages,
  chatSessionSkillBundles,
  chatSessions,
  skillBundleFiles,
  skillBundles,
  skillInstallations,
} from "./product-schema";

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
  sourceType: "github" | "skills.sh";
  sourceUrl: string;
  sourcePath: string;
  sourceRef: string;
  resolvedCommit: string;
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
        const bundleId = await ensureBundle(tx, input.actor.workspaceId, input.bundle);
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
        const bundleId = await ensureBundle(tx, input.actor.workspaceId, input.bundle);
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
    const rows = await this.db
      .select({
        name: skillInstallations.name,
        bundleName: skillBundles.name,
        description: skillBundles.description,
      })
      .from(skillInstallations)
      .innerJoin(
        skillBundles,
        and(
          eq(skillBundles.id, skillInstallations.bundleId),
          eq(skillBundles.workspaceId, skillInstallations.workspaceId),
        ),
      )
      .where(
        and(
          eq(skillInstallations.workspaceId, input.actor.workspaceId),
          eq(skillBundles.workspaceId, input.actor.workspaceId),
          eq(skillInstallations.enabled, true),
          isNull(skillInstallations.archivedAt),
        ),
      )
      .orderBy(asc(skillInstallations.name));
    return rows.map((row: { name: string; bundleName: string; description: string }) => ({
      id: row.name,
      name: row.bundleName,
      description: row.description,
    }));
  }

  async get(input: { actor: Parameters<SkillBundleRepository["get"]>[0]["actor"]; name: string }) {
    const row = await liveInstallation(this.db, input.actor.workspaceId, input.name);
    return row ? hydrateInstallation(this.db, row) : null;
  }

  async readFile(input: {
    actor: Parameters<SkillBundleRepository["readFile"]>[0]["actor"];
    name: string;
    path: string;
  }): Promise<SkillBundleFile | null> {
    assertSafeStoredPath(input.path);
    const [row] = await this.db
      .select({
        path: skillBundleFiles.path,
        content: skillBundleFiles.content,
        executable: skillBundleFiles.executable,
        sizeBytes: skillBundleFiles.sizeBytes,
      })
      .from(skillInstallations)
      .innerJoin(
        skillBundles,
        and(
          eq(skillBundles.id, skillInstallations.bundleId),
          eq(skillBundles.workspaceId, skillInstallations.workspaceId),
        ),
      )
      .innerJoin(
        skillBundleFiles,
        and(eq(skillBundleFiles.bundleId, skillBundles.id), eq(skillBundleFiles.path, input.path)),
      )
      .where(
        and(
          eq(skillInstallations.workspaceId, input.actor.workspaceId),
          eq(skillBundles.workspaceId, input.actor.workspaceId),
          eq(skillInstallations.name, input.name),
          isNull(skillInstallations.archivedAt),
        ),
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
    // Host-tool activation can race replacement or another model call, so serialize it per Chat
    // before applying the name-based first-writer rule.
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

      const existing = await tx
        .select({ name: skillBundles.name })
        .from(chatSessionSkillBundles)
        .innerJoin(skillBundles, eq(skillBundles.id, chatSessionSkillBundles.bundleId))
        .where(
          and(
            eq(chatSessionSkillBundles.chatSessionId, input.chatSessionId),
            eq(skillBundles.workspaceId, input.workspaceId),
          ),
        );
      const fixedNames = new Set(existing.map((row: { name: string }) => row.name));
      const newNames = new Set<string>();
      const values = candidates.flatMap((candidate: { id: string; name: string }) => {
        if (fixedNames.has(candidate.name) || newNames.has(candidate.name)) return [];
        newNames.add(candidate.name);
        const requested = requestedById.get(candidate.id)!;
        return [
          {
            chatSessionId: input.chatSessionId,
            bundleId: candidate.id,
            activatedMessageId: input.activatedMessageId,
            sourceKind: requested.sourceKind,
          },
        ];
      });
      if (values.length > 0) {
        await tx.insert(chatSessionSkillBundles).values(values).onConflictDoNothing();
      }
    }

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
  return db
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
    .orderBy(asc(skillBundles.name));
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
  return row
    ? {
        path: row.path,
        content: new Uint8Array(row.content),
        executable: row.executable,
        sizeBytes: row.sizeBytes,
      }
    : null;
}

async function ensureBundle(db: DbClient, workspaceId: string, bundle: ResolvedSkillBundle) {
  validateResolvedBundle(bundle);
  const recomputed = await computeArtifactIntegrity(bundle.files);
  if (recomputed !== bundle.integrity) {
    throw new CoreError(
      "conflict",
      "The Skill bundle changed before it could be stored. Preview it again.",
    );
  }

  const existing = await bundleByIntegrity(db, workspaceId, bundle.integrity);
  if (existing) return existing.id;

  const id = deterministicId("skill_bundle", workspaceId, bundle.integrity);
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
      sourceUrl: bundle.source.url,
      sourcePath: bundle.source.path,
      sourceRef: bundle.source.ref,
      resolvedCommit: bundle.source.resolvedCommit,
    })
    .onConflictDoNothing({
      target: [skillBundles.workspaceId, skillBundles.integrity],
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
  const winner = await bundleByIntegrity(db, workspaceId, bundle.integrity);
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

async function bundleByIntegrity(db: DbClient, workspaceId: string, integrity: string) {
  const [row] = await db
    .select({ id: skillBundles.id })
    .from(skillBundles)
    .where(and(eq(skillBundles.workspaceId, workspaceId), eq(skillBundles.integrity, integrity)))
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
      source: {
        type: row.sourceType,
        url: row.sourceUrl,
        path: row.sourcePath,
        ref: row.sourceRef,
        resolvedCommit: row.resolvedCommit,
      },
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
    source: {
      type: row.sourceType,
      url: row.sourceUrl,
      path: row.sourcePath,
      ref: row.sourceRef,
      resolvedCommit: row.resolvedCommit,
    },
    files,
    createdAt: row.bundleCreatedAt,
  };
}

function validateResolvedBundle(bundle: ResolvedSkillBundle) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(bundle.integrity)) {
    throw new CoreError("invalid_argument", "The Skill bundle integrity is invalid.");
  }
  if (!/^[0-9a-f]{40}$/u.test(bundle.source.resolvedCommit)) {
    throw new CoreError("invalid_argument", "The Skill source commit is invalid.");
  }
  if (bundle.source.path) assertSafeStoredPath(bundle.source.path);
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
    const parsed = parseSkillDocument(
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
