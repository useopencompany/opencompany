import { createHash } from "node:crypto";
import {
  assertSafeRelativePath,
  computeArtifactIntegrity,
  PLUGIN_LIMITS,
  parseMcpConfig,
  parsePluginManifest,
} from "@opencompany/agent-runtime";
import {
  CoreError,
  type PluginInstallation,
  type PluginInstallationListItem,
  type PluginInstallReport,
  type PluginRepository,
  type PluginSkillCollision,
  type ResolvedPluginPackage,
  type SkillBundleFileMetadata,
} from "@opencompany/core";
import { del } from "@vercel/blob";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import {
  pluginFiles,
  pluginSkills,
  plugins,
  skillBundles,
  workspacePluginData,
} from "./product-schema";
import { storeSkillBundle } from "./skill-bundle-repository";
import { resolveWorkspaceSkillCatalog } from "./skill-catalog";

type DbClient = any;

type PluginRow = {
  id: string;
  workspaceId: string;
  name: string;
  status: "enabled" | "disabled" | "archived";
  manifest: PluginInstallation["manifest"];
  sourceType: "github" | "skills.sh";
  sourceUrl: string;
  sourcePath: string;
  sourceRef: string;
  resolvedCommit: string;
  integrity: string;
  stdioMcpServers: PluginInstallation["stdioServers"];
  installReport: PluginInstallReport;
  mcpApprovedIntegrity: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

const pluginSelection = {
  id: plugins.id,
  workspaceId: plugins.workspaceId,
  name: plugins.name,
  status: plugins.status,
  manifest: plugins.manifest,
  sourceType: plugins.sourceType,
  sourceUrl: plugins.sourceUrl,
  sourcePath: plugins.sourcePath,
  sourceRef: plugins.sourceRef,
  resolvedCommit: plugins.resolvedCommit,
  integrity: plugins.integrity,
  stdioMcpServers: plugins.stdioMcpServers,
  installReport: plugins.installReport,
  mcpApprovedIntegrity: plugins.mcpApprovedIntegrity,
  createdAt: plugins.createdAt,
  updatedAt: plugins.updatedAt,
  archivedAt: plugins.archivedAt,
} as const;

export class PostgresPluginRepository implements PluginRepository {
  private readonly pluginDataStorage: PluginDataStorage;

  constructor(
    private readonly db: DbClient,
    options: { pluginDataStorage?: PluginDataStorage } = {},
  ) {
    this.pluginDataStorage = options.pluginDataStorage ?? {
      delete: async (pathname) => {
        await del(pathname);
      },
    };
  }

  async install(input: {
    actor: Parameters<PluginRepository["install"]>[0]["actor"];
    idempotencyKey: string;
    plugin: ResolvedPluginPackage;
  }) {
    const pluginId = deterministicId(
      "plugin",
      input.actor.userId,
      input.actor.workspaceId,
      input.idempotencyKey,
    );
    try {
      return await this.db.transaction(async (tx: DbClient) => {
        await validateResolvedPlugin(input.plugin);
        const replay = await pluginById(tx, input.actor.workspaceId, pluginId);
        if (replay) {
          if (
            replay.name !== input.plugin.manifest.name ||
            replay.integrity !== input.plugin.integrity ||
            replay.resolvedCommit !== input.plugin.source.resolvedCommit
          ) {
            throw new CoreError(
              "idempotency_conflict",
              "The Idempotency-Key was already used for another Plugin installation.",
            );
          }
          return { plugin: await hydratePlugin(tx, replay), idempotentReplay: true };
        }

        const initialReport: PluginInstallReport = {
          ...input.plugin.report,
          collisions: [],
        };
        await tx.insert(plugins).values({
          id: pluginId,
          workspaceId: input.actor.workspaceId,
          name: input.plugin.manifest.name,
          status: "enabled",
          manifest: input.plugin.manifest,
          sourceType: input.plugin.source.type,
          sourceUrl: input.plugin.source.url,
          sourcePath: input.plugin.source.path,
          sourceRef: input.plugin.source.ref,
          resolvedCommit: input.plugin.source.resolvedCommit,
          integrity: input.plugin.integrity,
          stdioMcpServers: input.plugin.stdioServers,
          installReport: initialReport,
          mcpApprovedIntegrity: null,
        });
        await tx.insert(pluginFiles).values(
          input.plugin.files.map((file) => ({
            pluginId,
            path: file.path,
            content: Buffer.from(file.content),
            executable: file.executable,
            sizeBytes: file.content.length,
          })),
        );

        for (const skill of input.plugin.skills) {
          const bundleId = await storeSkillBundle(tx, input.actor.workspaceId, skill.bundle);
          await tx.insert(pluginSkills).values({
            workspaceId: input.actor.workspaceId,
            pluginId,
            skillName: skill.bundle.name,
            skillPath: skill.path,
            skillBundleId: bundleId,
          });
        }

        const collisions = await currentSkillCollisions(tx, input.actor.workspaceId);
        await tx
          .update(plugins)
          .set({ installReport: { ...initialReport, collisions } })
          .where(and(eq(plugins.id, pluginId), eq(plugins.workspaceId, input.actor.workspaceId)));
        const created = await pluginById(tx, input.actor.workspaceId, pluginId);
        if (!created) throw new CoreError("conflict", "Could not install the Plugin.");
        return { plugin: await hydratePlugin(tx, created), idempotentReplay: false };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replay = await pluginById(this.db, input.actor.workspaceId, pluginId);
        if (
          replay?.name === input.plugin.manifest.name &&
          replay.integrity === input.plugin.integrity &&
          replay.resolvedCommit === input.plugin.source.resolvedCommit
        ) {
          return { plugin: await hydratePlugin(this.db, replay), idempotentReplay: true };
        }
      }
      throw pluginWriteError(error, input.plugin.manifest.name);
    }
  }

  async list(input: {
    actor: Parameters<PluginRepository["list"]>[0]["actor"];
  }): Promise<PluginInstallationListItem[]> {
    const rows = (await pluginQuery(this.db)
      .where(and(eq(plugins.workspaceId, input.actor.workspaceId), ne(plugins.status, "archived")))
      .orderBy(desc(plugins.updatedAt))) as PluginRow[];
    const hydrated = await Promise.all(rows.map((row) => hydratePlugin(this.db, row)));
    return hydrated.map(({ files, skills, stdioServers, ...plugin }) => ({
      ...plugin,
      fileCount: files.length,
      skillCount: skills.length,
      stdioServerCount: stdioServers.length,
    }));
  }

  async get(input: { actor: Parameters<PluginRepository["get"]>[0]["actor"]; name: string }) {
    const row = await livePlugin(this.db, input.actor.workspaceId, input.name);
    return row ? hydratePlugin(this.db, row) : null;
  }

  async setStatus(input: {
    actor: Parameters<PluginRepository["setStatus"]>[0]["actor"];
    name: string;
    status: "enabled" | "disabled";
  }) {
    const [updated] = await this.db
      .update(plugins)
      .set({ status: input.status, updatedAt: new Date() })
      .where(
        and(
          eq(plugins.workspaceId, input.actor.workspaceId),
          eq(plugins.name, input.name),
          inArray(plugins.status, ["enabled", "disabled"]),
        ),
      )
      .returning({ id: plugins.id });
    if (!updated) throw new CoreError("not_found", "Plugin not found.");
    const row = await pluginById(this.db, input.actor.workspaceId, updated.id);
    if (!row) throw new CoreError("not_found", "Plugin not found.");
    return hydratePlugin(this.db, row);
  }

  async archive(input: {
    actor: Parameters<PluginRepository["archive"]>[0]["actor"];
    name: string;
  }) {
    const now = new Date();
    const rows = await this.db
      .update(plugins)
      .set({
        status: "archived",
        archivedAt: now,
        updatedAt: now,
        mcpApprovedIntegrity: null,
      })
      .where(
        and(
          eq(plugins.workspaceId, input.actor.workspaceId),
          eq(plugins.name, input.name),
          inArray(plugins.status, ["enabled", "disabled"]),
        ),
      )
      .returning({ id: plugins.id });
    if (rows.length === 0) throw new CoreError("not_found", "Plugin not found.");
  }

  async deleteData(input: {
    actor: Parameters<PluginRepository["deleteData"]>[0]["actor"];
    name: string;
  }) {
    const plugin = await livePlugin(this.db, input.actor.workspaceId, input.name);
    if (!plugin) throw new CoreError("not_found", "Plugin not found.");
    const [data] = await this.db
      .select({
        blobPathname: workspacePluginData.blobPathname,
        checksum: workspacePluginData.checksum,
        generation: workspacePluginData.generation,
      })
      .from(workspacePluginData)
      .where(
        and(
          eq(workspacePluginData.workspaceId, input.actor.workspaceId),
          eq(workspacePluginData.pluginName, input.name),
        ),
      )
      .limit(1);
    if (!data) return { deleted: false };

    await this.pluginDataStorage.delete(data.blobPathname);
    const rows = await this.db
      .delete(workspacePluginData)
      .where(
        and(
          eq(workspacePluginData.workspaceId, input.actor.workspaceId),
          eq(workspacePluginData.pluginName, input.name),
          eq(workspacePluginData.blobPathname, data.blobPathname),
          eq(workspacePluginData.checksum, data.checksum),
          eq(workspacePluginData.generation, data.generation),
        ),
      )
      .returning({ pluginName: workspacePluginData.pluginName });
    return { deleted: rows.length > 0 };
  }
}

export type PluginDataStorage = {
  delete(pathname: string): Promise<void>;
};

function pluginQuery(db: DbClient) {
  return db.select(pluginSelection).from(plugins);
}

async function pluginById(db: DbClient, workspaceId: string, id: string) {
  const [row] = (await pluginQuery(db)
    .where(and(eq(plugins.id, id), eq(plugins.workspaceId, workspaceId)))
    .limit(1)) as PluginRow[];
  return row ?? null;
}

async function livePlugin(db: DbClient, workspaceId: string, name: string) {
  const [row] = (await pluginQuery(db)
    .where(
      and(
        eq(plugins.workspaceId, workspaceId),
        eq(plugins.name, name),
        inArray(plugins.status, ["enabled", "disabled"]),
      ),
    )
    .limit(1)) as PluginRow[];
  return row ?? null;
}

async function hydratePlugin(db: DbClient, row: PluginRow): Promise<PluginInstallation> {
  const [files, skills, collisions] = await Promise.all([
    db
      .select({
        path: pluginFiles.path,
        executable: pluginFiles.executable,
        sizeBytes: pluginFiles.sizeBytes,
      })
      .from(pluginFiles)
      .innerJoin(plugins, eq(plugins.id, pluginFiles.pluginId))
      .where(and(eq(pluginFiles.pluginId, row.id), eq(plugins.workspaceId, row.workspaceId)))
      .orderBy(asc(pluginFiles.path)),
    db
      .select({
        name: pluginSkills.skillName,
        path: pluginSkills.skillPath,
        bundleId: skillBundles.id,
        integrity: skillBundles.integrity,
        description: skillBundles.description,
      })
      .from(pluginSkills)
      .innerJoin(
        plugins,
        and(
          eq(plugins.id, pluginSkills.pluginId),
          eq(plugins.workspaceId, pluginSkills.workspaceId),
        ),
      )
      .innerJoin(
        skillBundles,
        and(
          eq(skillBundles.id, pluginSkills.skillBundleId),
          eq(skillBundles.workspaceId, pluginSkills.workspaceId),
        ),
      )
      .where(and(eq(pluginSkills.pluginId, row.id), eq(pluginSkills.workspaceId, row.workspaceId)))
      .orderBy(asc(pluginSkills.skillName)),
    currentSkillCollisions(db, row.workspaceId),
  ]);
  const relevantCollisions = collisions.filter(
    (collision) =>
      collision.hiddenPluginNames.includes(row.name) ||
      (collision.winner.source === "plugin" && collision.winner.pluginName === row.name),
  );
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    manifest: row.manifest,
    source: {
      type: row.sourceType,
      url: row.sourceUrl,
      path: row.sourcePath,
      ref: row.sourceRef,
      resolvedCommit: row.resolvedCommit,
    },
    integrity: row.integrity,
    files: files as SkillBundleFileMetadata[],
    skills,
    stdioServers: row.stdioMcpServers,
    installReport: { ...row.installReport, collisions: relevantCollisions },
    mcpApprovedIntegrity: row.mcpApprovedIntegrity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  };
}

export async function currentSkillCollisions(
  db: DbClient,
  workspaceId: string,
): Promise<PluginSkillCollision[]> {
  return (await resolveWorkspaceSkillCatalog(db, { workspaceId })).collisions;
}

async function validateResolvedPlugin(plugin: ResolvedPluginPackage) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(plugin.integrity)) {
    throw new CoreError("invalid_argument", "The Plugin package integrity is invalid.");
  }
  if (!/^[0-9a-f]{40}$/u.test(plugin.source.resolvedCommit)) {
    throw new CoreError("invalid_argument", "The Plugin source commit is invalid.");
  }
  if (plugin.source.path) assertSafePluginPath(plugin.source.path);
  if (plugin.files.length === 0 || plugin.files.length > PLUGIN_LIMITS.maxFileCount) {
    throw new CoreError("invalid_argument", "The Plugin package has an invalid file count.");
  }

  const packageFiles = new Map<string, ResolvedPluginPackage["files"][number]>();
  let totalBytes = 0;
  for (const file of plugin.files) {
    assertSafePluginPath(file.path);
    if (packageFiles.has(file.path)) {
      throw new CoreError("invalid_argument", `Duplicate Plugin file path: ${file.path}.`);
    }
    if (file.content.length > PLUGIN_LIMITS.maxFileBytes) {
      throw new CoreError("invalid_argument", `Plugin file ${file.path} is too large.`);
    }
    packageFiles.set(file.path, file);
    totalBytes += file.content.length;
  }
  if (!packageFiles.has("plugin.json") || totalBytes > PLUGIN_LIMITS.maxTotalBytes) {
    throw new CoreError("invalid_argument", "The Plugin package is incomplete or too large.");
  }
  if (plugin.fileCount !== plugin.files.length || plugin.totalBytes !== totalBytes) {
    throw new CoreError(
      "invalid_argument",
      "The Plugin package metadata does not match its files.",
    );
  }
  if ((await computeArtifactIntegrity(plugin.files)) !== plugin.integrity) {
    throw new CoreError(
      "conflict",
      "The Plugin package changed before it could be stored. Preview it again.",
    );
  }

  const manifestFile = packageFiles.get("plugin.json")!;
  let parsedManifest: ReturnType<typeof parsePluginManifest>["manifest"];
  try {
    parsedManifest = parsePluginManifest(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestFile.content),
    ).manifest;
  } catch (error) {
    throw new CoreError(
      "invalid_argument",
      error instanceof Error ? error.message : "The Plugin manifest is invalid.",
    );
  }
  if (JSON.stringify(parsedManifest) !== JSON.stringify(plugin.manifest)) {
    throw new CoreError("invalid_argument", "The Plugin manifest does not match plugin.json.");
  }

  const mcpFile = packageFiles.get("mcp.json");
  let parsedServers: ResolvedPluginPackage["stdioServers"] = [];
  if (mcpFile) {
    try {
      const parsed = parseMcpConfig(
        new TextDecoder("utf-8", { fatal: true }).decode(mcpFile.content),
      );
      if (parsed.status === "parsed") parsedServers = parsed.servers;
    } catch {
      parsedServers = [];
    }
  }
  if (JSON.stringify(parsedServers) !== JSON.stringify(plugin.stdioServers)) {
    throw new CoreError("invalid_argument", "The Plugin MCP entries do not match mcp.json.");
  }

  const skillNames = new Set<string>();
  for (const skill of plugin.skills) {
    assertSafePluginPath(skill.path);
    if (skillNames.has(skill.bundle.name)) {
      throw new CoreError("invalid_argument", `Duplicate Plugin Skill: ${skill.bundle.name}.`);
    }
    skillNames.add(skill.bundle.name);
    const packageSkillFiles = [...packageFiles.keys()].filter((path) =>
      path.startsWith(`${skill.path}/`),
    );
    if (packageSkillFiles.length !== skill.bundle.files.length) {
      throw new CoreError(
        "invalid_argument",
        `Plugin Skill ${skill.bundle.name} does not include every package file in its directory.`,
      );
    }
    for (const file of skill.bundle.files) {
      const packageFile = packageFiles.get(`${skill.path}/${file.path}`);
      if (
        !packageFile ||
        packageFile.executable !== file.executable ||
        !sameBytes(packageFile.content, file.content)
      ) {
        throw new CoreError(
          "invalid_argument",
          `Plugin Skill ${skill.bundle.name} does not match the package files.`,
        );
      }
    }
  }
  const reportedValidSkills = plugin.report.skills
    .filter((report) => report.status === "valid")
    .map((report) => report.name)
    .sort();
  if (JSON.stringify(reportedValidSkills) !== JSON.stringify([...skillNames].sort())) {
    throw new CoreError("invalid_argument", "The Plugin Skill report does not match its bundles.");
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function assertSafePluginPath(path: string) {
  try {
    assertSafeRelativePath(path);
  } catch (error) {
    throw new CoreError(
      "invalid_argument",
      error instanceof Error ? error.message : "The Plugin file path is invalid.",
    );
  }
}

function deterministicId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32)}`;
}

function pluginWriteError(error: unknown, name: string) {
  if (error instanceof CoreError) return error;
  if (isUniqueViolation(error)) {
    return new CoreError(
      "conflict",
      `A live Plugin named ${JSON.stringify(name)} is already installed in this workspace. Archive it before installing a replacement.`,
    );
  }
  return error;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: unknown };
  return value.code === "23505" || isUniqueViolation(value.cause);
}
