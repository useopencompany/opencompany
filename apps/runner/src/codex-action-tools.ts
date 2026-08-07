import {
  GOAT_ACTION_GATEWAY_TIMEOUT_MS,
  GOAT_ACTION_TOOL_CONTRACT,
  type GoatActionGatewayRequest,
  type GoatActionGatewayResponse,
} from "@opencompany/agent-runtime";
import type {
  CodexAppServerDynamicTool,
  CodexAppServerDynamicToolCall,
  CodexAppServerDynamicToolResponse,
} from "./codex-app-server";
import type { RunnerEnv } from "./env";

const GOAT_ACTION_GATEWAY_PATH = "/api/internal/action-gateway";

type GoatCodexActionToolContext = {
  codexChatSessionId: string;
  codexChatTurnId: string;
  env: Pick<RunnerEnv, "goatAppUrl" | "internalToken">;
  checkAbort: () => Promise<void>;
};

type GoatCodexActionToolDependencies = {
  fetch: typeof fetch;
};

const defaultDependencies: GoatCodexActionToolDependencies = {
  fetch: globalThis.fetch,
};

export function createGoatCodexActionDynamicTools(
  context: GoatCodexActionToolContext,
  dependencies: Partial<GoatCodexActionToolDependencies> = {},
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
  context: GoatCodexActionToolContext;
  dependencies: GoatCodexActionToolDependencies;
  request: GoatActionGatewayRequest | { invalid: GoatActionGatewayResponse };
}): Promise<CodexAppServerDynamicToolResponse> {
  if ("invalid" in input.request) return modelResponse(input.request.invalid);

  const appUrl = input.context.env.goatAppUrl?.trim();
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
  context: GoatCodexActionToolContext,
  value: unknown,
): GoatActionGatewayRequest | { invalid: GoatActionGatewayResponse } {
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
  context: GoatCodexActionToolContext,
  call: CodexAppServerDynamicToolCall,
):
  | { ok: true; request: GoatActionGatewayRequest }
  | { ok: false; response: GoatActionGatewayResponse } {
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

async function readGatewayResponse(response: Response): Promise<GoatActionGatewayResponse> {
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

function isGatewayResponse(value: unknown): value is GoatActionGatewayResponse {
  return isRecord(value) && typeof value.ok === "boolean";
}

function invalidParams(message: string): { invalid: GoatActionGatewayResponse } {
  return { invalid: invalidParamsResponse(message) };
}

function invalidParamsResponse(message: string): GoatActionGatewayResponse {
  return { ok: false, error: { code: "invalid_params", message } };
}

function modelResponse(response: GoatActionGatewayResponse): CodexAppServerDynamicToolResponse {
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
