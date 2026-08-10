import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GOAT_ACTION_TOOL_CONTRACT,
  GOAT_PUBLISH_ARTIFACT_INPUT_JSON_SCHEMA,
  GOAT_PUBLISH_ARTIFACT_TOOL_DESCRIPTION,
  GOAT_PUBLISH_ARTIFACT_TOOL_NAME,
  type GoatActionGatewayRequest,
  type GoatActionGatewayResponse,
  type GoatPublishArtifactToolResponse,
} from "@opencompany/agent-runtime";
import * as z from "zod/v4-mini";
import { executeGoatActionGateway } from "@/lib/codex-actions";
import { requestGoatChatArtifactPublication } from "@/lib/task-runner";

export type GoatClaudeActionToolContext = {
  codexChatSessionId: string;
  codexChatTurnId: string;
  signal?: AbortSignal;
};

type GoatClaudeActionToolDependencies = {
  executeAction: typeof executeGoatActionGateway;
  publishArtifact: typeof requestGoatChatArtifactPublication;
};

// MCP requires Zod validators, while Codex accepts JSON Schema directly. Build
// the MCP validators from the same dependency-light contract so field names,
// requiredness, descriptions, and annotations cannot drift between harnesses.
const listActionsInputSchema = mcpInputSchema(GOAT_ACTION_TOOL_CONTRACT.list.inputSchema);
const useActionInputSchema = mcpInputSchema(GOAT_ACTION_TOOL_CONTRACT.execute.inputSchema);
const publishArtifactInputSchema = mcpInputSchema(GOAT_PUBLISH_ARTIFACT_INPUT_JSON_SCHEMA);

export function registerGoatClaudeActionTools(
  server: McpServer,
  ctx: GoatClaudeActionToolContext,
  dependencies: Partial<GoatClaudeActionToolDependencies> = {},
) {
  const executeAction = dependencies.executeAction ?? executeGoatActionGateway;
  const publishArtifact = dependencies.publishArtifact ?? requestGoatChatArtifactPublication;

  server.registerTool(
    GOAT_PUBLISH_ARTIFACT_TOOL_NAME,
    {
      title: "Publish file",
      description: GOAT_PUBLISH_ARTIFACT_TOOL_DESCRIPTION,
      inputSchema: publishArtifactInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      const response = await publishArtifact({
        codexChatSessionId: ctx.codexChatSessionId,
        codexChatTurnId: ctx.codexChatTurnId,
        toolCallId: mcpInvocationId(ctx.codexChatTurnId, extra.sessionId, extra.requestId),
        arguments: args,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return mcpPublishResult(response);
    },
  );

  server.registerTool(
    GOAT_ACTION_TOOL_CONTRACT.list.name,
    {
      title: GOAT_ACTION_TOOL_CONTRACT.list.title,
      description: GOAT_ACTION_TOOL_CONTRACT.list.description,
      inputSchema: listActionsInputSchema,
      annotations: GOAT_ACTION_TOOL_CONTRACT.list.annotations,
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
    GOAT_ACTION_TOOL_CONTRACT.execute.name,
    {
      title: GOAT_ACTION_TOOL_CONTRACT.execute.title,
      description: GOAT_ACTION_TOOL_CONTRACT.execute.description,
      inputSchema: useActionInputSchema,
      annotations: GOAT_ACTION_TOOL_CONTRACT.execute.annotations,
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
          : property.type === "integer"
            ? z.number().check(z.int())
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
  executeAction: typeof executeGoatActionGateway,
  ctx: GoatClaudeActionToolContext,
  request: GoatActionGatewayRequest,
) {
  const response = await executeAction({
    request,
    signal: ctx.signal ?? new AbortController().signal,
  });
  return mcpResult(response);
}

function mcpResult(response: GoatActionGatewayResponse) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
    structuredContent: response as unknown as Record<string, unknown>,
    isError: !response.ok,
  };
}

function mcpPublishResult(response: GoatPublishArtifactToolResponse) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
    structuredContent: response as unknown as Record<string, unknown>,
    isError: !response.ok,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
