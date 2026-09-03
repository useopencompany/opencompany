import type { AcpEngineAdapter, AcpMcpServer } from "./acp-harness";
import { ACP_TOOLS_MCP_SERVER_NAME } from "./acp-tools-client";
import { buildClaudeAcpCommand } from "./claude-code-cli";
import { buildCodexAcpCommand } from "./codex-cli";

function keyValuePairsToRecord(values: Array<{ name: string; value: string }>) {
  return Object.fromEntries(values.map(({ name, value }) => [name, value]));
}

function toClaudeMcpServerConfig(server: AcpMcpServer) {
  if ("type" in server) {
    return {
      type: server.type,
      url: server.url,
      headers: keyValuePairsToRecord(server.headers),
      alwaysLoad: true,
    };
  }
  return {
    type: "stdio" as const,
    command: server.command,
    args: server.args,
    env: keyValuePairsToRecord(server.env),
    alwaysLoad: true,
  };
}

export const CLAUDE_ACP_ENGINE_ADAPTER: AcpEngineAdapter = {
  id: "claude_code",
  displayName: "Claude Code",
  command: buildClaudeAcpCommand,
  prepareSession: ({ mcpServers }) => {
    const coreMcpServers = mcpServers.filter((server) => server.name === ACP_TOOLS_MCP_SERVER_NAME);
    const deferredMcpServers = mcpServers.filter(
      (server) => server.name !== ACP_TOOLS_MCP_SERVER_NAME,
    );

    return {
      // claude-agent-acp currently drops Claude SDK-only MCP fields such as `alwaysLoad`
      // when it translates ACP servers. Pass the core gateway through its native options so
      // Claude waits for the tools before turn one; plugin servers can remain deferred.
      mcpServers: deferredMcpServers,
      meta: {
        claudeCode: {
          options: {
            maxTurns: 250,
            ...(mcpServers.length > 0 ? { strictMcpConfig: true } : {}),
            ...(coreMcpServers.length > 0
              ? {
                  mcpServers: Object.fromEntries(
                    coreMcpServers.map((server) => [server.name, toClaudeMcpServerConfig(server)]),
                  ),
                }
              : {}),
          },
        },
      },
    };
  },
  configOptions: {
    model: "model",
    reasoningEffort: {
      id: "effort",
      value: (effort) => (effort === "xhigh" ? "max" : effort),
    },
    permissionMode: {
      id: "mode",
      values: { default: "default", bypassPermissions: "bypassPermissions" },
    },
  },
};

export const CODEX_ACP_ENGINE_ADAPTER: AcpEngineAdapter = {
  id: "codex",
  displayName: "Codex",
  command: buildCodexAcpCommand,
  configOptions: {
    model: "model",
    reasoningEffort: { id: "reasoning_effort", value: (effort) => effort },
    permissionMode: {
      id: "mode",
      values: { default: "agent", bypassPermissions: "agent-full-access" },
    },
    collaborationMode: {
      id: "collaboration_mode",
      values: { default: "default", plan: "plan" },
    },
  },
  steeringControlMethod: "_session/steering",
};

export const ACP_ENGINE_ADAPTERS = {
  claude_code: CLAUDE_ACP_ENGINE_ADAPTER,
  codex: CODEX_ACP_ENGINE_ADAPTER,
} as const satisfies Record<"claude_code" | "codex", AcpEngineAdapter>;
