import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WORKSPACE_SKILL_TOOL_CONTRACTS,
  type WorkspaceSkillToolName,
} from "../workspace-skill-tools";
import { mcpInputSchema } from "./external-engine-tools";

export function registerExternalEngineSkillTools(
  server: McpServer,
  execute: (input: {
    tool: WorkspaceSkillToolName;
    args: Record<string, unknown>;
    invocationId: string;
  }) => Promise<unknown>,
) {
  for (const contract of WORKSPACE_SKILL_TOOL_CONTRACTS) {
    server.registerTool(
      contract.name,
      {
        description: contract.description,
        inputSchema: mcpInputSchema(contract.inputSchema),
        annotations: {
          readOnlyHint: false,
          destructiveHint: contract.name !== "create_workspace_skill",
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args, extra) => {
        try {
          const result = await execute({
            tool: contract.name,
            args,
            invocationId: JSON.stringify([extra.sessionId ?? "http", extra.requestId]),
          });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : "Skill operation failed.",
              },
            ],
          };
        }
      },
    );
  }
}
