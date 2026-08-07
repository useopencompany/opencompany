import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ACTION_TOOL_CONTRACT,
  type ActionGatewayRequest,
  type ActionGatewayResponse,
} from "@opencompany/agent-runtime";
import * as z from "zod/v4-mini";
import { executeActionGateway } from "@/lib/codex-actions";

export type ClaudeActionToolContext = {
  codexChatSessionId: string;
  codexChatTurnId: string;
  signal?: AbortSignal;
};

type ClaudeActionToolDependencies = {
  executeAction: typeof executeActionGateway;
};

// MCP requires Zod validators, while Codex accepts JSON Schema directly. Build
// the MCP validators from the same dependency-light contract so field names,
// requiredness, descriptions, and annotations cannot drift between harnesses.
const listActionsInputSchema = mcpInputSchema(ACTION_TOOL_CONTRACT.list.inputSchema);
const useActionInputSchema = mcpInputSchema(ACTION_TOOL_CONTRACT.execute.inputSchema);

export function registerClaudeActionTools(
  server: McpServer,
  ctx: ClaudeActionToolContext,
  dependencies: Partial<ClaudeActionToolDependencies> = {},
) {
  const executeAction = dependencies.executeAction ?? executeActionGateway;

  server.registerTool(
    ACTION_TOOL_CONTRACT.list.name,
    {
      title: ACTION_TOOL_CONTRACT.list.title,
      description: ACTION_TOOL_CONTRACT.list.description,
      inputSchema: listActionsInputSchema,
      annotations: ACTION_TOOL_CONTRACT.list.annotations,
    },
    async (args) => {
      const source = typeof args.source === "string" ? args.source : undefined;
      return runGateway(executeAction, ctx, {
        operation: "list",
        sessionId: ctx.codexChatSessionId,
        turnId: ctx.codexChatTurnId,
        ...(source ? { source } : {}),
      });
    },
  );

  server.registerTool(
    ACTION_TOOL_CONTRACT.execute.name,
    {
      title: ACTION_TOOL_CONTRACT.execute.title,
      description: ACTION_TOOL_CONTRACT.execute.description,
      inputSchema: useActionInputSchema,
      annotations: ACTION_TOOL_CONTRACT.execute.annotations,
    },
    async (args, extra) => {
      const action = typeof args.action === "string" ? args.action : "";
      const params = isRecord(args.params) ? args.params : {};
      return runGateway(executeAction, ctx, {
        operation: "execute",
        sessionId: ctx.codexChatSessionId,
        turnId: ctx.codexChatTurnId,
        action,
        params,
        invocationId: mcpInvocationId(ctx.codexChatTurnId, extra.sessionId, extra.requestId),
      });
    },
  );
}

type ContractInputSchema = {
  properties: Record<
    string,
    {
      type: string;
      description?: string;
    }
  >;
  required?: readonly string[];
};

function mcpInputSchema(schema: ContractInputSchema): Record<string, z.ZodMiniType> {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(schema.properties).map(([name, property]) => {
      let validator: z.ZodMiniType =
        property.type === "string"
          ? z.string()
          : property.type === "object"
            ? z.record(z.string(), z.unknown())
            : z.unknown();
      if (property.description) {
        validator = validator.check(z.meta({ description: property.description }));
      }
      return [name, required.has(name) ? validator : z.optional(validator)];
    }),
  );
}

function mcpInvocationId(
  turnId: string,
  transportSessionId: string | undefined,
  requestId: unknown,
) {
  return ["mcp", turnId, transportSessionId ?? "http", String(requestId)]
    .map(encodeURIComponent)
    .join(":");
}

async function runGateway(
  executeAction: typeof executeActionGateway,
  ctx: ClaudeActionToolContext,
  request: ActionGatewayRequest,
) {
  const response = await executeAction({
    request,
    signal: ctx.signal ?? new AbortController().signal,
  });
  return mcpResult(response);
}

function mcpResult(response: ActionGatewayResponse) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
    structuredContent: response as unknown as Record<string, unknown>,
    isError: !response.ok,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
