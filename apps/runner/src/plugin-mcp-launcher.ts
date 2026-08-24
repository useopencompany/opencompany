import { createHash } from "node:crypto";
import { shellQuote } from "@opencompany/agent-runtime";
import type { PluginStdioServer } from "@opencompany/core";
import type { EnabledPluginRuntime } from "@opencompany/db/plugin-runtime-repository";
import { verifyManagedPathCommand } from "./managed-artifact-tree";
import { type SandboxHandle, writeSandboxTextFiles } from "./sandbox";

const SANDBOX_ROOT_USER = "root";
const SANDBOX_ENGINE_USER = "user";
const PLUGIN_RUNTIME_PATH = "/usr/local/bin:/usr/bin:/bin";
const SUDO_PATH = "/usr/bin/sudo";
const SUDOERS_PATH = "/etc/sudoers.d/opencompany-plugin-mcp";
const PLUGIN_RUNTIME_MANIFEST = ".opencompany-plugin-runtime.json";
const RESERVED_PLUGIN_ENV_NAMES = new Set(["PATH", "HOME", "LANG", "PLUGIN_ROOT", "PLUGIN_DATA"]);

export type PreparedPluginMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

export type PluginMcpLauncherRuntime = {
  servers: PreparedPluginMcpServer[];
  fingerprint: string;
  pluginUsers: Array<{ pluginName: string; user: string }>;
};

export async function materializeTrustedPluginMcpLaunchers(input: {
  sandbox: SandboxHandle;
  workRoot: string;
  mcpPlugins: EnabledPluginRuntime["mcpPlugins"];
  dataRoots: ReadonlyMap<string, string>;
}): Promise<PluginMcpLauncherRuntime> {
  const runtimeRoot = `${input.workRoot}/.opencompany/plugin-runtime`;
  const launcherPath = `${runtimeRoot}/launcher.py`;
  const manifestPath = `${runtimeRoot}/${PLUGIN_RUNTIME_MANIFEST}`;
  const configs: Array<{
    pluginName: string;
    serverName: string;
    namespace: string;
    user: string;
    configPath: string;
    config: string;
  }> = [];
  const pluginUsers = input.mcpPlugins.map((plugin) => ({
    pluginName: plugin.name,
    user: pluginRuntimeUser(plugin.name),
  }));
  for (const plugin of input.mcpPlugins) {
    assertRuntimePlugin(plugin);
    const dataRoot = input.dataRoots.get(plugin.name);
    if (!dataRoot) throw new Error(`Plugin ${JSON.stringify(plugin.name)} data was not restored.`);
    const pluginRoot = `${input.workRoot}/.opencompany/plugins/${plugin.name}`;
    const user = pluginRuntimeUser(plugin.name);
    for (const server of plugin.stdioServers) {
      assertRuntimeServer(server);
      const namespace = `${plugin.name}.${server.name}`;
      const configPath = `${runtimeRoot}/configs/${hashId(namespace)}.json`;
      configs.push({
        pluginName: plugin.name,
        serverName: server.name,
        namespace,
        user,
        configPath,
        config: JSON.stringify({
          version: 1,
          namespace,
          pluginRoot,
          dataRoot,
          command: server.command,
          args: server.args,
          env: server.env,
          cwd: server.cwd ?? "${PLUGIN_ROOT}",
        }),
      });
    }
  }

  await input.sandbox.commands.run(verifyManagedPathCommand(runtimeRoot), {
    user: SANDBOX_ROOT_USER,
    timeoutMs: 30_000,
  });
  const stalePluginUsers = await readStalePluginUsers(
    input.sandbox,
    manifestPath,
    input.mcpPlugins,
  );
  await input.sandbox.commands.run(
    [
      verifyManagedPathCommand(runtimeRoot),
      ...stalePluginUsers.map(
        (user) => `{ pkill -KILL -u ${shellQuote(user)} 2>/dev/null || true; }`,
      ),
      `rm -rf ${shellQuote(runtimeRoot)}`,
      `mkdir -p ${shellQuote(`${runtimeRoot}/configs`)}`,
      verifyManagedPathCommand(runtimeRoot, true),
      ...pluginUsers.map(
        ({ user }) =>
          `{ getent passwd ${shellQuote(user)} >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin ${shellQuote(user)}; }`,
      ),
      `test -x ${shellQuote(SUDO_PATH)}`,
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
  await input.sandbox.commands.run(verifyManagedPathCommand(runtimeRoot, true), {
    user: SANDBOX_ROOT_USER,
    timeoutMs: 30_000,
  });
  const sudoers = configs
    .map(
      ({ user, configPath }) =>
        `${SANDBOX_ENGINE_USER} ALL=(${user}) NOPASSWD: ${launcherPath} ${configPath}`,
    )
    .join("\n");
  await writeSandboxTextFiles({
    sandbox: input.sandbox,
    files: [
      { path: launcherPath, content: trustedPluginMcpLauncherScript },
      ...configs.map(({ configPath, config }) => ({ path: configPath, content: config })),
      { path: `${runtimeRoot}/sudoers`, content: sudoers ? `${sudoers}\n` : "" },
      {
        path: manifestPath,
        content: JSON.stringify({
          version: 1,
          plugins: input.mcpPlugins.map((plugin) => ({
            name: plugin.name,
            integrity: plugin.integrity,
          })),
        }),
      },
    ],
    user: SANDBOX_ROOT_USER,
  });
  await input.sandbox.commands.run(
    [
      verifyManagedPathCommand(runtimeRoot, true),
      `chown ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${shellQuote(launcherPath)}`,
      `chmod 555 ${shellQuote(launcherPath)}`,
      `chown ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${shellQuote(manifestPath)}`,
      `chmod 444 ${shellQuote(manifestPath)}`,
      ...configs.flatMap(({ configPath, user }) => [
        `chown ${SANDBOX_ROOT_USER}:${shellQuote(user)} ${shellQuote(configPath)}`,
        `chmod 440 ${shellQuote(configPath)}`,
      ]),
      ...(configs.length > 0
        ? [
            `install -o root -g root -m 0440 ${shellQuote(`${runtimeRoot}/sudoers`)} ${shellQuote(SUDOERS_PATH)}`,
            `visudo -cf ${shellQuote(SUDOERS_PATH)} >/dev/null`,
          ]
        : [`rm -f ${shellQuote(SUDOERS_PATH)}`]),
      `chmod 555 ${shellQuote(`${runtimeRoot}/configs`)} ${shellQuote(runtimeRoot)}`,
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );

  const servers = configs.map(({ namespace, user, configPath }) => ({
    name: namespace,
    command: SUDO_PATH,
    args: ["-n", "-u", user, "--", launcherPath, configPath],
    env: [],
  }));
  return {
    servers,
    fingerprint: launcherFingerprint(input.mcpPlugins),
    pluginUsers,
  };
}

async function readStalePluginUsers(
  sandbox: SandboxHandle,
  manifestPath: string,
  currentPlugins: EnabledPluginRuntime["mcpPlugins"],
) {
  try {
    const parsed = JSON.parse(String(await sandbox.files.read(manifestPath))) as {
      version?: unknown;
      plugins?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.plugins)) return [];
    const currentIntegrities = new Map(
      currentPlugins.map((plugin) => [plugin.name, plugin.integrity]),
    );
    return parsed.plugins.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const { name, integrity } = entry as { name?: unknown; integrity?: unknown };
      return typeof name === "string" &&
        isRuntimePluginName(name) &&
        (typeof integrity !== "string" || currentIntegrities.get(name) !== integrity)
        ? [pluginRuntimeUser(name)]
        : [];
    });
  } catch {
    return [];
  }
}

export function buildPluginProcessEnvironment(input: {
  pluginRoot: string;
  dataRoot: string;
  declaredEnv: Record<string, string>;
}) {
  const environment: Record<string, string> = {
    PATH: PLUGIN_RUNTIME_PATH,
    HOME: input.dataRoot,
    LANG: "C.UTF-8",
  };
  for (const [name, value] of Object.entries(input.declaredEnv)) {
    if (RESERVED_PLUGIN_ENV_NAMES.has(name)) {
      throw new Error("Plugin MCP environment declares a reserved variable.");
    }
    environment[name] = expandPluginVariablesOnce(value, input);
  }
  environment.PLUGIN_ROOT = input.pluginRoot;
  environment.PLUGIN_DATA = input.dataRoot;
  return environment;
}

export function expandPluginVariablesOnce(
  value: string,
  roots: { pluginRoot: string; dataRoot: string },
) {
  return value.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/gu, (_match, name: string) =>
    name === "PLUGIN_ROOT" ? roots.pluginRoot : roots.dataRoot,
  );
}

export async function stopPluginMcpProcesses(
  sandbox: SandboxHandle,
  pluginUsers: PluginMcpLauncherRuntime["pluginUsers"],
) {
  if (pluginUsers.length === 0) return;
  await sandbox.commands.run(
    pluginUsers
      .map(({ user }) => `{ pkill -KILL -u ${shellQuote(user)} 2>/dev/null || true; }`)
      .join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
}

function assertRuntimePlugin(plugin: EnabledPluginRuntime["mcpPlugins"][number]) {
  if (!isRuntimePluginName(plugin.name)) {
    throw new Error("Approved Plugin MCP configuration has an invalid plugin name.");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(plugin.integrity)) {
    throw new Error(`Plugin ${JSON.stringify(plugin.name)} has invalid package integrity.`);
  }
}

function isRuntimePluginName(name: string) {
  return (
    name.length <= 64 &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(name) &&
    !name.includes("--") &&
    !name.includes("..")
  );
}

function assertRuntimeServer(server: PluginStdioServer) {
  if (!server.name || server.name.length > 128 || /[\0\r\n]/u.test(server.name)) {
    throw new Error("Approved Plugin MCP configuration has an invalid server name.");
  }
  if (!server.command || /\s/u.test(server.command)) {
    throw new Error(`Plugin MCP server ${JSON.stringify(server.name)} has an invalid executable.`);
  }
  if (!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === "string")) {
    throw new Error(`Plugin MCP server ${JSON.stringify(server.name)} has invalid arguments.`);
  }
  if (
    !server.env ||
    Array.isArray(server.env) ||
    Object.entries(server.env).some(
      ([name, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
        typeof value !== "string" ||
        RESERVED_PLUGIN_ENV_NAMES.has(name),
    )
  ) {
    throw new Error(
      `Plugin MCP server ${JSON.stringify(server.name)} has invalid environment declarations.`,
    );
  }
  if (server.cwd !== undefined && typeof server.cwd !== "string") {
    throw new Error(
      `Plugin MCP server ${JSON.stringify(server.name)} has an invalid working directory.`,
    );
  }
}

export function pluginRuntimeUser(pluginName: string) {
  return `ocp_${hashId(pluginName).slice(0, 20)}`;
}

function hashId(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function launcherFingerprint(plugins: EnabledPluginRuntime["mcpPlugins"]) {
  const hash = createHash("sha256");
  hash.update(trustedPluginMcpLauncherScript);
  hash.update(JSON.stringify(plugins));
  return hash.digest("hex");
}

export function codexPluginMcpConfig(servers: PreparedPluginMcpServer[]) {
  if (servers.length === 0) return "";
  return `${servers
    .map((server) =>
      [
        `[mcp_servers.${JSON.stringify(server.name)}]`,
        `command = ${JSON.stringify(server.command)}`,
        `args = ${JSON.stringify(server.args)}`,
      ].join("\n"),
    )
    .join("\n\n")}\n`;
}

export const trustedPluginMcpLauncherScript = String.raw`#!/usr/bin/python3
import json
import os
import re
import shutil
import stat
import sys

RUNTIME_PATH = "/usr/local/bin:/usr/bin:/bin"

def fail(namespace, message):
    print(f"Plugin MCP {namespace} failed: {message}", file=sys.stderr)
    raise SystemExit(126)

def expand_once(value, plugin_root, data_root):
    return re.sub(r"\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}", lambda match: plugin_root if match.group(1) == "PLUGIN_ROOT" else data_root, value)

config_path = os.path.realpath(sys.argv[1])
with open(config_path, "r", encoding="utf-8") as source:
    config = json.load(source)
namespace = config.get("namespace", "unknown")
try:
    if config.get("version") != 1:
        raise RuntimeError("invalid launcher configuration")
    plugin_root = config["pluginRoot"]
    data_root = config["dataRoot"]
    if os.path.realpath(plugin_root) != plugin_root or not os.path.isdir(plugin_root):
        raise RuntimeError("materialized plugin root failed containment verification")
    if os.path.realpath(data_root) != data_root or not os.path.isdir(data_root):
        raise RuntimeError("plugin data directory failed containment verification")

    raw_cwd = expand_once(config["cwd"], plugin_root, data_root)
    cwd = raw_cwd if os.path.isabs(raw_cwd) else os.path.join(plugin_root, raw_cwd)
    cwd = os.path.realpath(cwd)
    contained = cwd == plugin_root or cwd.startswith(plugin_root + os.sep) or cwd == data_root or cwd.startswith(data_root + os.sep)
    if not contained or not os.path.isdir(cwd):
        raise RuntimeError("working directory escapes the plugin roots")

    command = config["command"]
    if command.startswith("./"):
        executable = os.path.realpath(os.path.join(plugin_root, command[2:]))
        if not executable.startswith(plugin_root + os.sep):
            raise RuntimeError("plugin executable escapes the materialized package")
    elif "/" not in command:
        executable = shutil.which(command, path=RUNTIME_PATH)
    else:
        executable = None
    if not executable or not os.path.isabs(executable):
        raise RuntimeError("executable could not be resolved")
    executable_stat = os.stat(executable, follow_symlinks=True)
    if not stat.S_ISREG(executable_stat.st_mode) or not os.access(executable, os.X_OK):
        raise RuntimeError("resolved executable is not executable")

    args = [expand_once(value, plugin_root, data_root) for value in config["args"]]
    environment = {"PATH": RUNTIME_PATH, "HOME": data_root, "LANG": "C.UTF-8"}
    for name, value in config["env"].items():
        if name in ("PATH", "HOME", "LANG", "PLUGIN_ROOT", "PLUGIN_DATA"):
            raise RuntimeError("environment declares a reserved variable")
        environment[name] = expand_once(value, plugin_root, data_root)
    environment["PLUGIN_ROOT"] = plugin_root
    environment["PLUGIN_DATA"] = data_root
    os.chdir(cwd)
    os.execve(executable, [executable, *args], environment)
except Exception as error:
    fail(namespace, str(error))
`;
