import type { AcpEngineAdapter } from "./acp-harness";
import { buildClaudeAcpCommand } from "./claude-code-cli";
import { buildCodexAcpCommand } from "./codex-cli";

export const CLAUDE_ACP_ENGINE_ADAPTER: AcpEngineAdapter = {
  id: "claude_code",
  displayName: "Claude Code",
  command: buildClaudeAcpCommand,
  sessionMeta: ({ hasMcpServers }) => ({
    claudeCode: {
      options: {
        maxTurns: 250,
        ...(hasMcpServers ? { strictMcpConfig: true } : {}),
      },
    },
  }),
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
