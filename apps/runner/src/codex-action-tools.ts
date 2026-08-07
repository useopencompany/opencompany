import {
  type ActionGatewayRequest,
  type ActionGatewayResponse,
  GOAT_ACTION_GATEWAY_TIMEOUT_MS,
  GOAT_ACTION_TOOL_CONTRACT,
} from "@opencompany/agent-runtime";
import type {
  CodexAppServerDynamicTool,
  CodexAppServerDynamicToolCall,
  CodexAppServerDynamicToolResponse,
} from "./codex-app-server";
import type { RunnerEnv } from "./env";

const GOAT_ACTION_GATEWAY_PATH = "/api/internal/action-gateway";

type CodexActionToolContext = {
  codexChatSessionId: string;
  codexChatTurnId: string;
  env: Pick<RunnerEnv, "appUrl" | "internalToken">;
  checkAbort: () => Promise<void>;
};

type CodexActionToolDependencies = {
  fetch: typeof fetch;
};

const defaultDependencies: CodexActionToolDependencies = {
  fetch: globalThis.fetch,
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
        name: GOAT_ACTION_TOOL_CONTRACT.list.name,
        description: GOAT_ACTION_TOOL_CONTRACT.list.description,
        inputSchema: GOAT_ACTION_TOOL_CONTRACT.list.inputSchema,
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
        name: GOAT_ACTION_TOOL_CONTRACT.execute.name,
        description: GOAT_ACTION_TOOL_CONTRACT.execute.description,
        inputSchema: GOAT_ACTION_TOOL_CONTRACT.execute.inputSchema,
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

  const appUrl = input.context.env.appUrl?.trim();
  if (!appUrl) {
    return modelResponse({
      ok: false,
      error: {
        code: "not_configured",
        message: "Actions are not configured for this Codex runner.",
      },
    });
  }

  try {
    await input.context.checkAbort();
    const response = await input.dependencies.fetch(new URL(GOAT_ACTION_GATEWAY_PATH, appUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.context.env.internalToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.request),
      signal: AbortSignal.timeout(GOAT_ACTION_GATEWAY_TIMEOUT_MS),
    });
    const result = await readGatewayResponse(response);
    await input.context.checkAbort();
    return modelResponse(result);
  } catch (error) {
    return modelResponse({
      ok: false,
      error: {
        code: "gateway_error",
        message:
          error instanceof Error
            ? `The integration action gateway could not be reached: ${error.message}`
            : "The integration action gateway could not be reached.",
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

async function readGatewayResponse(response: Response): Promise<ActionGatewayResponse> {
  try {
    const value = (await response.json()) as unknown;
    if (isGatewayResponse(value)) return value;
  } catch {
    // Fall through to a bounded status-only error; never send an HTML proxy body to the model.
  }
  return {
    ok: false,
    error: {
      code: "gateway_error",
      message: `The integration action gateway returned HTTP ${response.status}.`,
    },
  };
}

function isGatewayResponse(value: unknown): value is ActionGatewayResponse {
  return isRecord(value) && typeof value.ok === "boolean";
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
