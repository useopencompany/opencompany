import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type GoatClaudeActionToolDependencies,
  registerGoatClaudeActionServiceTools,
} from "@opencompany/goat-agent/application/claude-tools";
import { executeGoatActionGateway } from "@/lib/codex-actions";
import { requestGoatChatArtifactPublication } from "@/lib/task-runner";

export type GoatClaudeActionToolContext = {
  codexChatSessionId: string;
  codexChatTurnId: string;
  signal?: AbortSignal;
};

type WebClaudeActionToolDependencies = {
  executeAction: GoatClaudeActionToolDependencies["executeAction"];
  publishArtifact: typeof requestGoatChatArtifactPublication;
};

const defaultDependencies: WebClaudeActionToolDependencies = {
  executeAction: executeGoatActionGateway,
  publishArtifact: requestGoatChatArtifactPublication,
};

export function registerGoatClaudeActionTools(
  server: McpServer,
  context: GoatClaudeActionToolContext,
  dependencies: Partial<WebClaudeActionToolDependencies> = {},
) {
  const resolved = {
    ...defaultDependencies,
    ...dependencies,
  };
  return registerGoatClaudeActionServiceTools(
    server,
    {
      sessionId: context.codexChatSessionId,
      runId: context.codexChatTurnId,
      ...(context.signal ? { signal: context.signal } : {}),
    },
    {
      executeAction: resolved.executeAction,
      publishArtifact: ({ sessionId, runId, ...input }) =>
        resolved.publishArtifact({
          ...input,
          codexChatSessionId: sessionId,
          codexChatTurnId: runId,
        }),
    },
  );
}
