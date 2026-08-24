import { createHash } from "node:crypto";
import path from "node:path";
import { assertSafeRelativePath, shellQuote } from "@opencompany/agent-runtime";
import type { ImmutablePluginPackage } from "@opencompany/db/plugin-runtime-repository";
import { type SandboxHandle, writeSandboxTextFiles } from "./sandbox";

const SANDBOX_ROOT_USER = "root";
const MANAGED_PLUGINS_MANIFEST = ".opencompany-managed-plugins.json";

export async function materializePluginPackagesForSession(input: {
  sandbox: SandboxHandle;
  workRoot: string;
  plugins: ImmutablePluginPackage[];
}): Promise<{ fingerprint: string; count: number }> {
  const root = `${input.workRoot}/.opencompany/plugins`;
  const manifestPath = `${root}/${MANAGED_PLUGINS_MANIFEST}`;
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
  const currentPluginNames = [...pluginNames];
  const previousPluginNames = await readManagedPluginNames(input.sandbox, manifestPath);
  const resetPluginNames = [...new Set([...previousPluginNames, ...currentPluginNames])];
  const quotedRoot = shellQuote(root);
  await input.sandbox.commands.run(
    [
      `if [ -L ${quotedRoot} ] || { [ -e ${quotedRoot} ] && [ ! -d ${quotedRoot} ]; }; then rm -f ${quotedRoot}; fi`,
      `mkdir -p ${quotedRoot}`,
      `chown ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${quotedRoot}`,
      `chmod 755 ${quotedRoot}`,
      ...resetPluginNames.map((name) => `rm -rf ${shellQuote(`${root}/${name}`)}`),
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );

  await writeSandboxTextFiles({
    sandbox: input.sandbox,
    files: [
      ...files.map(({ path: filePath, content }) => ({ path: filePath, content })),
      {
        path: manifestPath,
        content: JSON.stringify({ version: 1, pluginNames: currentPluginNames }, null, 2),
      },
    ],
    user: SANDBOX_ROOT_USER,
  });

  const managedPaths = currentPluginNames.map((name) => shellQuote(`${root}/${name}`));
  const executablePaths = files
    .filter((file) => file.executable)
    .map((file) => shellQuote(file.path));
  await input.sandbox.commands.run(
    [
      `chown ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${shellQuote(manifestPath)}`,
      `chmod 444 ${shellQuote(manifestPath)}`,
      ...(managedPaths.length > 0
        ? [
            `chown -R ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${managedPaths.join(" ")}`,
            `find ${managedPaths.join(" ")} -type d -exec chmod 555 {} +`,
            `find ${managedPaths.join(" ")} -type f -exec chmod 444 {} +`,
          ]
        : []),
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
  for (const chunk of chunkShellArguments(executablePaths)) {
    await input.sandbox.commands.run(`chmod 555 ${chunk.join(" ")}`, {
      user: SANDBOX_ROOT_USER,
      timeoutMs: 30_000,
    });
  }
  await input.sandbox.commands.run(
    [
      `chown ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${shellQuote(root)}`,
      `chmod 555 ${shellQuote(root)}`,
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );

  return { fingerprint: pluginTreeFingerprint(input.plugins), count: input.plugins.length };
}

export function combineManagedArtifactFingerprints(...fingerprints: string[]) {
  const hash = createHash("sha256");
  for (const fingerprint of fingerprints) hashField(hash, Buffer.from(fingerprint, "utf8"));
  return hash.digest("hex");
}

async function readManagedPluginNames(sandbox: SandboxHandle, manifestPath: string) {
  try {
    const parsed = JSON.parse(String(await sandbox.files.read(manifestPath))) as {
      version?: unknown;
      pluginNames?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.pluginNames)) return [];
    return parsed.pluginNames.filter((name): name is string => {
      if (typeof name !== "string") return false;
      try {
        assertSafePluginName(name);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function assertSafePluginName(name: string) {
  try {
    assertSafeRelativePath(name);
  } catch {
    throw new Error(`Cannot materialize Plugin with unsafe name: ${name}`);
  }
  if (name.includes("/")) throw new Error(`Cannot materialize Plugin with unsafe name: ${name}`);
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

function pluginTreeFingerprint(plugins: ImmutablePluginPackage[]) {
  const hash = createHash("sha256");
  for (const plugin of [...plugins].sort((left, right) => compareText(left.name, right.name))) {
    hashField(hash, Buffer.from("plugin", "utf8"));
    hashField(hash, Buffer.from(plugin.id, "utf8"));
    hashField(hash, Buffer.from(plugin.name, "utf8"));
    for (const file of [...plugin.files].sort((left, right) =>
      compareText(left.path, right.path),
    )) {
      hashField(hash, Buffer.from("file", "utf8"));
      hashField(hash, Buffer.from(file.path, "utf8"));
      hashField(hash, Uint8Array.of(file.executable ? 1 : 0));
      hashField(hash, file.content);
    }
  }
  return hash.digest("hex");
}

function hashField(hash: ReturnType<typeof createHash>, bytes: Uint8Array) {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function chunkShellArguments(args: string[], maxCharacters = 24_000) {
  const chunks: string[][] = [];
  let current: string[] = [];
  let characters = 0;
  for (const argument of args) {
    if (current.length > 0 && characters + argument.length + 1 > maxCharacters) {
      chunks.push(current);
      current = [];
      characters = 0;
    }
    current.push(argument);
    characters += argument.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
