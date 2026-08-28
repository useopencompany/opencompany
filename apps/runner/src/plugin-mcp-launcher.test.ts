import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPluginProcessEnvironment,
  expandPluginVariablesOnce,
  materializeTrustedPluginMcpLaunchers,
  pluginRuntimeUser,
  trustedPluginMcpLauncherScript,
} from "./plugin-mcp-launcher";

describe("Plugin MCP trusted launcher", () => {
  it("constructs the child environment exactly without inheriting runner secrets", () => {
    const environment = buildPluginProcessEnvironment({
      pluginRoot: "/workspace/.opencompany/plugins/quality-tools",
      dataRoot: "/workspace/.opencompany/plugin-data/quality-tools",
      declaredEnv: {
        CACHE_DIR: "${PLUGIN_DATA}/cache",
        ENTRYPOINT: "${PLUGIN_ROOT}/server.mjs",
        PUBLIC_MODE: "safe",
      },
    });

    expect(environment).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/workspace/.opencompany/plugin-data/quality-tools",
      LANG: "C.UTF-8",
      CACHE_DIR: "/workspace/.opencompany/plugin-data/quality-tools/cache",
      ENTRYPOINT: "/workspace/.opencompany/plugins/quality-tools/server.mjs",
      PUBLIC_MODE: "safe",
      PLUGIN_ROOT: "/workspace/.opencompany/plugins/quality-tools",
      PLUGIN_DATA: "/workspace/.opencompany/plugin-data/quality-tools",
    });
    for (const secretName of [
      "ANTHROPIC_API_KEY",
      "CODEX_API_KEY",
      "OPENAI_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "DATABASE_URL",
      "RUNNER_INTERNAL_TOKEN",
      "BLOB_READ_WRITE_TOKEN",
    ]) {
      expect(environment).not.toHaveProperty(secretName);
    }
  });

  it("expands PLUGIN_ROOT and PLUGIN_DATA exactly once", () => {
    expect(
      expandPluginVariablesOnce("${PLUGIN_ROOT}/literal/${PLUGIN_DATA}", {
        pluginRoot: "/plugin/${PLUGIN_DATA}",
        dataRoot: "/data/${PLUGIN_ROOT}",
      }),
    ).toBe("/plugin/${PLUGIN_DATA}/literal//data/${PLUGIN_ROOT}");
  });

  it("executes with exactly the allowlist, declarations, and Plugin roots", () => {
    const temporaryRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "opencompany-mcp-")));
    const pluginRoot = path.join(temporaryRoot, "plugin");
    const dataRoot = path.join(temporaryRoot, "data");
    const launcherPath = path.join(temporaryRoot, "launcher.py");
    const configPath = path.join(temporaryRoot, "config.json");
    mkdirSync(pluginRoot);
    mkdirSync(dataRoot);
    writeFileSync(launcherPath, trustedPluginMcpLauncherScript);
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        namespace: "quality-tools.environment",
        pluginRoot,
        dataRoot,
        command: "env",
        args: [],
        cwd: "${PLUGIN_DATA}",
        env: { CACHE_DIR: "${PLUGIN_DATA}/cache", PUBLIC_MODE: "safe" },
      }),
    );
    try {
      const output = execFileSync("python3", [launcherPath, configPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "model-secret",
          GH_TOKEN: "github-secret",
          DATABASE_URL: "repository-secret",
          RUNNER_INTERNAL_TOKEN: "runner-secret",
        },
      });
      const environment = Object.fromEntries(
        output
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );

      expect(environment).toEqual({
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: dataRoot,
        LANG: "C.UTF-8",
        CACHE_DIR: `${dataRoot}/cache`,
        PUBLIC_MODE: "safe",
        PLUGIN_ROOT: pluginRoot,
        PLUGIN_DATA: dataRoot,
      });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("namespaces approved servers and emits an empty outer environment", async () => {
    const writes: Array<Array<{ path: string; data: unknown }>> = [];
    const commands: string[] = [];
    const sandbox = {
      commands: {
        run: async (command: string) => {
          commands.push(command);
          return {};
        },
      },
      files: {
        write: async (files: Array<{ path: string; data: unknown }>) => {
          writes.push(files);
        },
      },
    };
    const runtime = await materializeTrustedPluginMcpLaunchers({
      sandbox: sandbox as never,
      workRoot: "/workspace",
      mcpPlugins: [
        {
          id: "plugin_1",
          name: "quality-tools",
          integrity: `sha256:${"a".repeat(64)}`,
          stdioServers: [
            {
              name: "local",
              type: "stdio",
              command: "node",
              args: ["${PLUGIN_ROOT}/server.mjs"],
              cwd: "${PLUGIN_DATA}",
              env: { CACHE_DIR: "${PLUGIN_DATA}/cache" },
            },
          ],
        },
      ],
      dataRoots: new Map([["quality-tools", "/workspace/.opencompany/plugin-data/quality-tools"]]),
    });

    const runtimeUser = pluginRuntimeUser("quality-tools");
    expect(runtime.servers).toEqual([
      {
        name: "quality-tools.local",
        command: "/usr/bin/sudo",
        args: [
          "-n",
          "-u",
          runtimeUser,
          "--",
          "/workspace/.opencompany/plugin-runtime/launcher.py",
          expect.stringMatching(/\/configs\/[a-f0-9]{64}\.json$/u),
        ],
        env: [],
      },
    ]);
    const flatFiles = writes.flat();
    const config = flatFiles.find((file) => file.path.endsWith(".json"));
    expect(JSON.parse(String(config?.data))).toMatchObject({
      namespace: "quality-tools.local",
      pluginRoot: "/workspace/.opencompany/plugins/quality-tools",
      dataRoot: "/workspace/.opencompany/plugin-data/quality-tools",
      command: "node",
    });
    const sudoers = flatFiles.find((file) => file.path.endsWith("/sudoers"));
    expect(String(sudoers?.data)).toContain(
      `user ALL=(${runtimeUser}) NOPASSWD: /workspace/.opencompany/plugin-runtime/launcher.py`,
    );
    expect(commands.join("\n")).toContain(
      "test \"$(realpath -m -- '/workspace/.opencompany')\" = '/workspace/.opencompany'",
    );
  });

  it("kills stale Plugin users and removes sudoers when approval disappears", async () => {
    const commands: string[] = [];
    const writes: Array<Array<{ path: string; data: unknown }>> = [];
    const sandbox = {
      commands: {
        run: async (command: string) => {
          commands.push(command);
          return {};
        },
      },
      files: {
        read: async () =>
          JSON.stringify({
            version: 1,
            plugins: [{ name: "quality-tools", integrity: `sha256:${"a".repeat(64)}` }],
          }),
        write: async (files: Array<{ path: string; data: unknown }>) => {
          writes.push(files);
        },
      },
    };

    const runtime = await materializeTrustedPluginMcpLaunchers({
      sandbox: sandbox as never,
      workRoot: "/workspace",
      mcpPlugins: [],
      dataRoots: new Map(),
    });

    expect(runtime.servers).toEqual([]);
    expect(commands.join("\n")).toContain(
      `{ pkill -KILL -u '${pluginRuntimeUser("quality-tools")}' 2>/dev/null || true; }`,
    );
    expect(commands.join("\n")).toContain("rm -f '/etc/sudoers.d/opencompany-plugin-mcp'");
    const manifest = writes
      .flat()
      .find((file) => file.path.endsWith("/.opencompany-plugin-runtime.json"));
    expect(JSON.parse(String(manifest?.data))).toEqual({ version: 1, plugins: [] });
  });

  it("rejects invalid approved runtime declarations without exposing env values", async () => {
    const error = await materializeTrustedPluginMcpLaunchers({
      sandbox: {} as never,
      workRoot: "/workspace",
      mcpPlugins: [
        {
          id: "plugin_1",
          name: "quality-tools",
          integrity: `sha256:${"a".repeat(64)}`,
          stdioServers: [
            {
              name: "local",
              type: "stdio",
              command: "node --inspect",
              args: [],
              env: { SAFE_NAME: "do-not-leak-this-value" },
            },
          ],
        },
      ],
      dataRoots: new Map([["quality-tools", "/workspace/.opencompany/plugin-data/quality-tools"]]),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("invalid executable");
    expect(String(error)).not.toContain("do-not-leak-this-value");
  });
});
