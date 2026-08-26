import {
  createGitHubPluginFetcher,
  PluginResolverError,
  resolvePlugin,
} from "@opencompany/agent-runtime";
import {
  CoreError,
  type PluginImportResolver,
  type ResolvedPluginPackage,
} from "@opencompany/core";

const TRUSTED_CAPABILITY_SOURCES = ["useopencompany/opencompany-experimental"] as const;

export function createPluginImportResolver(): PluginImportResolver {
  return { resolve: resolvePluginImport };
}

export async function resolvePluginImport(input: {
  url: string;
  selectedPath?: string;
}): Promise<ResolvedPluginPackage> {
  try {
    const plugin = await resolvePlugin({
      url: input.url,
      fetcher: createGitHubPluginFetcher(),
      trustedCapabilitySources: TRUSTED_CAPABILITY_SOURCES,
      ...(input.selectedPath !== undefined ? { selectedPath: input.selectedPath } : {}),
    });
    return {
      manifest: plugin.manifest,
      source: { ...plugin.source, resolvedCommit: plugin.resolvedCommit },
      integrity: plugin.integrity,
      files: plugin.files,
      fileCount: plugin.fileCount,
      totalBytes: plugin.totalBytes,
      skills: plugin.skills.map((skill) => ({
        path: skill.path,
        bundle: {
          name: skill.name,
          description: skill.description,
          ...(skill.license !== undefined ? { license: skill.license } : {}),
          ...(skill.compatibility !== undefined ? { compatibility: skill.compatibility } : {}),
          ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
          ...(skill.allowedTools !== undefined ? { allowedTools: skill.allowedTools } : {}),
          body: skill.body,
          source: {
            ...plugin.source,
            path: plugin.source.path ? `${plugin.source.path}/${skill.path}` : skill.path,
            resolvedCommit: plugin.resolvedCommit,
          },
          integrity: skill.integrity,
          files: skill.files,
          fileCount: skill.fileCount,
          totalBytes: skill.totalBytes,
        },
      })),
      stdioServers: plugin.stdioServers,
      remoteServers: plugin.remoteServers,
      capabilities: plugin.capabilities,
      report: plugin.report,
    };
  } catch (error) {
    if (error instanceof PluginResolverError) {
      throw new CoreError("invalid_argument", error.message);
    }
    throw new CoreError(
      "unavailable",
      "Couldn't read that plugin right now. Check the URL and try again.",
    );
  }
}
