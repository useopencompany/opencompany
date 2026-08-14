import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ACTION_TOOL_CONTRACT,
  type ActionGatewayRequest,
  type ActionGatewayResponse,
  PUBLISH_ARTIFACT_INPUT_JSON_SCHEMA,
  PUBLISH_ARTIFACT_TOOL_DESCRIPTION,
  PUBLISH_ARTIFACT_TOOL_NAME,
  type PublishArtifactToolResponse,
} from "@opencompany/agent-runtime";
import * as z from "zod/v4-mini";

export type ClaudeToolContext = {
  sessionId: string;
  runId: string;
  signal?: AbortSignal;
};

export type ClaudeActionToolDependencies = {
  executeAction: (input: {
    request: ActionGatewayRequest;
    signal: AbortSignal;
  }) => Promise<ActionGatewayResponse>;
  publishArtifact: (input: {
    sessionId: string;
    runId: string;
    toolCallId: string;
    arguments: unknown;
    signal?: AbortSignal;
  }) => Promise<PublishArtifactToolResponse>;
};

// MCP requires Zod validators, while Codex accepts JSON Schema directly. Build
// the MCP validators from the same dependency-light contract so field names,
// requiredness, descriptions, and annotations cannot drift between harnesses.
const listActionsInputSchema = mcpInputSchema(ACTION_TOOL_CONTRACT.list.inputSchema);
const useActionInputSchema = mcpInputSchema(ACTION_TOOL_CONTRACT.execute.inputSchema);
const publishArtifactInputSchema = mcpInputSchema(PUBLISH_ARTIFACT_INPUT_JSON_SCHEMA);

export function registerClaudeActionServiceTools(
  server: McpServer,
  ctx: ClaudeToolContext,
  dependencies: ClaudeActionToolDependencies,
) {
  server.registerTool(
    PUBLISH_ARTIFACT_TOOL_NAME,
    {
      title: "Publish file",
      description: PUBLISH_ARTIFACT_TOOL_DESCRIPTION,
      inputSchema: publishArtifactInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      const response = await dependencies.publishArtifact({
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        toolCallId: mcpInvocationId(ctx.runId, extra.sessionId, extra.requestId),
        arguments: args,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return mcpPublishResult(response);
    },
  );

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
      return runGateway(dependencies.executeAction, ctx, {
        operation: "list",
        sessionId: ctx.sessionId,
        turnId: ctx.runId,
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
      return runGateway(dependencies.executeAction, ctx, {
        operation: "execute",
        sessionId: ctx.sessionId,
        turnId: ctx.runId,
        action,
        params,
        invocationId: mcpInvocationId(ctx.runId, extra.sessionId, extra.requestId),
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
  executeAction: ClaudeActionToolDependencies["executeAction"],
  ctx: ClaudeToolContext,
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

function mcpPublishResult(response: PublishArtifactToolResponse) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
    structuredContent: response as unknown as Record<string, unknown>,
    isError: !response.ok,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
