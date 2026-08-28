import path from "node:path";
import { assertSafeRelativePath } from "@opencompany/agent-runtime";
import type { ImmutablePluginPackage } from "@opencompany/db/plugin-runtime-repository";
import {
  combineManagedArtifactFingerprints,
  managedArtifactFingerprint,
  reconcileManagedArtifactTree,
} from "./managed-artifact-tree";
import type { SandboxHandle } from "./sandbox";

const MANAGED_PLUGINS_MANIFEST = ".opencompany-managed-plugins.json";

export { combineManagedArtifactFingerprints };

export async function materializePluginPackagesForSession(input: {
  sandbox: SandboxHandle;
  workRoot: string;
  plugins: ImmutablePluginPackage[];
}): Promise<{ fingerprint: string; count: number }> {
  const root = `${input.workRoot}/.opencompany/plugins`;
  const pluginNames = new Set<string>();
  const files = input.plugins.flatMap((plugin) => {
    assertSafePluginName(plugin.name);
    if (pluginNames.has(plugin.name)) {
      throw new Error(`Cannot materialize duplicate Plugin name: ${plugin.name}`);
    }
    pluginNames.add(plugin.name);
    const paths = new Set<string>();
    return plugin.files.map((file) => {
      if (paths.has(file.path)) {
        throw new Error(`Cannot materialize duplicate Plugin file path: ${file.path}`);
      }
      paths.add(file.path);
      return {
        path: containedPluginFilePath(root, plugin.name, file.path),
        content: file.content,
        executable: file.executable,
      };
    });
  });
  await reconcileManagedArtifactTree({
    sandbox: input.sandbox,
    root,
    manifestName: MANAGED_PLUGINS_MANIFEST,
    manifestKey: "pluginNames",
    ids: [...pluginNames],
    files,
    isSafeId: isSafePluginName,
  });
  return {
    fingerprint: managedArtifactFingerprint(
      input.plugins.map((plugin) => ({
        kind: "plugin",
        id: plugin.name,
        fields: [plugin.id],
        files: plugin.files,
      })),
    ),
    count: input.plugins.length,
  };
}

function assertSafePluginName(name: string) {
  if (!isSafePluginName(name))
    throw new Error(`Cannot materialize Plugin with unsafe name: ${name}`);
}

function isSafePluginName(name: string) {
  try {
    assertSafeRelativePath(name);
    return !name.includes("/");
  } catch {
    return false;
  }
}

function containedPluginFilePath(root: string, pluginName: string, relativePath: string) {
  try {
    assertSafeRelativePath(relativePath);
  } catch (error) {
    throw new Error(
      `Cannot materialize Plugin file with unsafe path ${JSON.stringify(relativePath)}: ${error instanceof Error ? error.message : "invalid path"}`,
    );
  }
  const pluginRoot = path.posix.resolve(root, pluginName);
  const targetPath = path.posix.resolve(pluginRoot, relativePath);
  if (!targetPath.startsWith(`${pluginRoot}/`)) {
    throw new Error(`Cannot materialize Plugin file outside its root: ${relativePath}`);
  }
  return targetPath;
}
