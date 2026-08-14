import { executeActionGateway } from "@opencompany/agent/application/persisted-action-gateway";
import {
  ACTION_TOOL_CONTRACT,
  type ActionGatewayRequest,
  type ActionGatewayResponse,
} from "@opencompany/agent-runtime";
import type {
  CodexAppServerDynamicTool,
  CodexAppServerDynamicToolCall,
  CodexAppServerDynamicToolResponse,
} from "./codex-app-server";

type CodexActionToolContext = {
  codexChatSessionId: string;
  codexChatTurnId: string;
  checkAbort: () => Promise<void>;
};

type CodexActionToolDependencies = {
  execute: typeof executeActionGateway;
};

const defaultDependencies: CodexActionToolDependencies = {
  execute: executeActionGateway,
};

export function createCodexActionDynamicTools(
  context: CodexActionToolContext,
  dependencies: Partial<CodexActionToolDependencies> = {},
): CodexAppServerDynamicTool[] {
  const resolvedDependencies = { ...defaultDependencies, ...dependencies };
  return [
    {
      spec: {
        type: "function",
        name: ACTION_TOOL_CONTRACT.list.name,
        description: ACTION_TOOL_CONTRACT.list.description,
        inputSchema: ACTION_TOOL_CONTRACT.list.inputSchema,
      },
      execute: (call) =>
        executeGatewayCall({
          context,
          dependencies: resolvedDependencies,
          request: listRequest(context, call.arguments),
        }),
    },
    {
      spec: {
        type: "function",
        name: ACTION_TOOL_CONTRACT.execute.name,
        description: ACTION_TOOL_CONTRACT.execute.description,
        inputSchema: ACTION_TOOL_CONTRACT.execute.inputSchema,
      },
      execute: async (call) => {
        const parsed = executeRequest(context, call);
        if (!parsed.ok) return modelResponse(parsed.response);
        return executeGatewayCall({
          context,
          dependencies: resolvedDependencies,
          request: parsed.request,
        });
      },
    },
  ];
}

async function executeGatewayCall(input: {
  context: CodexActionToolContext;
  dependencies: CodexActionToolDependencies;
  request: ActionGatewayRequest | { invalid: ActionGatewayResponse };
}): Promise<CodexAppServerDynamicToolResponse> {
  if ("invalid" in input.request) return modelResponse(input.request.invalid);

  try {
    await input.context.checkAbort();
    const result = await input.dependencies.execute({
      request: input.request,
      signal: AbortSignal.timeout(30_000),
    });
    await input.context.checkAbort();
    return modelResponse(result);
  } catch (error) {
    return modelResponse({
      ok: false,
      error: {
        code: "gateway_error",
        message:
          error instanceof Error
            ? `The integration action service failed: ${error.message}`
            : "The integration action service failed.",
      },
    });
  }
}

function listRequest(
  context: CodexActionToolContext,
  value: unknown,
): ActionGatewayRequest | { invalid: ActionGatewayResponse } {
  if (!isRecord(value)) return invalidParams("list_actions expects an object.");
  const source = optionalString(value.source);
  if (value.source !== undefined && !source) {
    return invalidParams("source must be a non-empty string when provided.");
  }
  return {
    operation: "list",
    sessionId: context.codexChatSessionId,
    turnId: context.codexChatTurnId,
    ...(source ? { source } : {}),
  };
}

function executeRequest(
  context: CodexActionToolContext,
  call: CodexAppServerDynamicToolCall,
): { ok: true; request: ActionGatewayRequest } | { ok: false; response: ActionGatewayResponse } {
  if (!isRecord(call.arguments)) {
    return { ok: false, response: invalidParamsResponse("use_action expects an object.") };
  }
  const action = optionalString(call.arguments.action);
  if (!action || !isRecord(call.arguments.params)) {
    return {
      ok: false,
      response: invalidParamsResponse("action and params are required."),
    };
  }
  return {
    ok: true,
    request: {
      operation: "execute",
      sessionId: context.codexChatSessionId,
      turnId: context.codexChatTurnId,
      action,
      params: call.arguments.params,
      invocationId: call.callId,
    },
  };
}

function invalidParams(message: string): { invalid: ActionGatewayResponse } {
  return { invalid: invalidParamsResponse(message) };
}

function invalidParamsResponse(message: string): ActionGatewayResponse {
  return { ok: false, error: { code: "invalid_params", message } };
}

function modelResponse(response: ActionGatewayResponse): CodexAppServerDynamicToolResponse {
  return {
    success: response.ok,
    contentItems: [{ type: "inputText", text: JSON.stringify(response) }],
  };
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
