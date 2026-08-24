import type { SkillBundleFile } from "@opencompany/core";
import { CoreError } from "@opencompany/core";
import { and, eq, inArray } from "drizzle-orm";
import { chatSessionPlugins, pluginFiles, plugins } from "./product-schema";
import { type ImmutableSkillBundle, loadImmutableSkillBundles } from "./skill-bundle-repository";
import { resolveWorkspaceSkillCatalog } from "./skill-catalog";

type DbClient = any;

export type ImmutablePluginPackage = {
  id: string;
  name: string;
  files: SkillBundleFile[];
};

export type EnabledPluginRuntime = {
  plugins: ImmutablePluginPackage[];
  skills: ImmutableSkillBundle[];
};

export async function loadChatSessionPluginRuntime(
  db: DbClient,
  input: { workspaceId: string; chatSessionId: string },
): Promise<EnabledPluginRuntime> {
  const snapshot = await db
    .select({ pluginId: chatSessionPlugins.pluginId })
    .from(chatSessionPlugins)
    .where(eq(chatSessionPlugins.chatSessionId, input.chatSessionId));
  return loadEnabledPluginRuntime(db, {
    workspaceId: input.workspaceId,
    pluginIds: snapshot.map((row: { pluginId: string }) => row.pluginId),
  });
}

export async function loadEnabledPluginRuntime(
  db: DbClient,
  input: { workspaceId: string; pluginIds: readonly string[] },
): Promise<EnabledPluginRuntime> {
  const pluginIds = [...new Set(input.pluginIds)];
  if (pluginIds.length === 0) return { plugins: [], skills: [] };

  const [pluginRows, fileRows, catalog] = await Promise.all([
    db
      .select({ id: plugins.id, name: plugins.name })
      .from(plugins)
      .where(
        and(
          eq(plugins.workspaceId, input.workspaceId),
          eq(plugins.status, "enabled"),
          inArray(plugins.id, pluginIds),
        ),
      ),
    db
      .select({
        pluginId: pluginFiles.pluginId,
        path: pluginFiles.path,
        content: pluginFiles.content,
        executable: pluginFiles.executable,
        sizeBytes: pluginFiles.sizeBytes,
      })
      .from(pluginFiles)
      .innerJoin(plugins, eq(plugins.id, pluginFiles.pluginId))
      .where(
        and(
          eq(plugins.workspaceId, input.workspaceId),
          eq(plugins.status, "enabled"),
          inArray(plugins.id, pluginIds),
        ),
      ),
    resolveWorkspaceSkillCatalog(db, { workspaceId: input.workspaceId, pluginIds }),
  ]);

  const filesByPlugin = new Map<string, SkillBundleFile[]>();
  for (const row of fileRows as Array<{
    pluginId: string;
    path: string;
    content: Uint8Array;
    executable: boolean;
    sizeBytes: number;
  }>) {
    const files = filesByPlugin.get(row.pluginId) ?? [];
    files.push({
      path: row.path,
      content: new Uint8Array(row.content),
      executable: row.executable,
      sizeBytes: row.sizeBytes,
    });
    filesByPlugin.set(row.pluginId, files);
  }

  const packages = (pluginRows as Array<{ id: string; name: string }>).map((plugin) => {
    const files = filesByPlugin.get(plugin.id);
    if (!files?.length) {
      throw new CoreError(
        "not_found",
        `Plugin package ${JSON.stringify(plugin.name)} is incomplete.`,
      );
    }
    files.sort((left, right) => compareText(left.path, right.path));
    return { ...plugin, files };
  });
  packages.sort((left, right) => compareText(left.name, right.name));

  const winningPluginBundleIds = catalog.skills.flatMap((skill) =>
    skill.sourceKind === "plugin" ? [skill.bundleId] : [],
  );
  const skills = await loadImmutableSkillBundles(db, {
    workspaceId: input.workspaceId,
    bundleIds: winningPluginBundleIds,
  });
  return { plugins: packages, skills };
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
