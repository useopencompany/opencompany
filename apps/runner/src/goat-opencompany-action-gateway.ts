import {
  GOAT_ACTION_GATEWAY_TIMEOUT_MS,
  type GoatActionGatewayResponse,
  type GoatActionHostGatewayRequest,
} from "@opencompany/agent-runtime";
import type { ActionDispatcher } from "@opencompany/goat-agent/chat-agent";
import type { GoatChatActionCatalog, UseActionToolOutput } from "@opencompany/goat-agent/chat-ui";
import type { RunnerEnv } from "./env";

const GOAT_ACTION_GATEWAY_PATH = "/api/internal/action-gateway";

type GatewayContext = {
  sessionId: string;
  turnId: string;
  env: Pick<RunnerEnv, "goatAppUrl" | "internalToken">;
  signal: AbortSignal;
  approvalContinuation: boolean;
};

type GatewayDependencies = { fetch: typeof fetch };

const defaultDependencies: GatewayDependencies = { fetch: globalThis.fetch };

export async function createGoatOpenCompanyActionDispatcher(
  context: GatewayContext,
  dependencies: Partial<GatewayDependencies> = {},
): Promise<ActionDispatcher | null> {
  if (!context.env.goatAppUrl?.trim() || !context.env.internalToken.trim()) return null;
  const resolvedDependencies = { ...defaultDependencies, ...dependencies };
  const response = await callGateway(
    context,
    resolvedDependencies,
    gatewayRequest(context, { operation: "catalog" }),
  );
  if (!response.ok || !("catalog" in response)) return null;

  const catalog = response.catalog as GoatChatActionCatalog;
  const sourceByAction = new Map(catalog.actions.map((action) => [action.id, action.source]));

  return {
    catalog,
    ...(context.approvalContinuation
      ? { prelistedSourceIds: catalog.sources.map((source) => source.id) }
      : {}),
    needsApproval: async ({ action, params, toolCallId }) => {
      const approval = await callGateway(
        context,
        resolvedDependencies,
        gatewayRequest(context, {
          operation: "approval",
          action,
          params,
          invocationId: toolCallId,
        }),
      );
      if (!approval.ok || !("needsApproval" in approval)) {
        throw new Error("Action approval could not be evaluated.");
      }
      return approval.needsApproval;
    },
    execute: async ({ action, params, toolCallId }) => {
      const source = sourceByAction.get(action);
      if (!source) return invalidAction(action);

      // The model-facing action service enforces discovery in memory. Mirror that
      // admission in the durable gateway immediately before dispatch so retries
      // and approval continuations share the same server-side call budget.
      const listed = await callGateway(
        context,
        resolvedDependencies,
        gatewayRequest(context, { operation: "list", source }),
      );
      if (!listed.ok) return listed as UseActionToolOutput;

      return (await callGateway(
        context,
        resolvedDependencies,
        gatewayRequest(context, {
          operation: "execute",
          action,
          params,
          invocationId: toolCallId,
        }),
      )) as UseActionToolOutput;
    },
  };
}

function gatewayRequest<T extends Omit<GoatActionHostGatewayRequest, "sessionId" | "turnId">>(
  context: GatewayContext,
  request: T,
): GoatActionHostGatewayRequest {
  return {
    ...request,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as GoatActionHostGatewayRequest;
}

async function callGateway(
  context: GatewayContext,
  dependencies: GatewayDependencies,
  request: GoatActionHostGatewayRequest,
): Promise<GoatActionGatewayResponse> {
  const appUrl = context.env.goatAppUrl?.trim();
  if (!appUrl) return gatewayError("not_configured", "The action gateway is not configured.");
  try {
    const timeoutSignal = AbortSignal.timeout(GOAT_ACTION_GATEWAY_TIMEOUT_MS);
    const response = await dependencies.fetch(new URL(GOAT_ACTION_GATEWAY_PATH, appUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${context.env.internalToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.any([context.signal, timeoutSignal]),
    });
    return await readGatewayResponse(response);
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason ?? error;
    return gatewayError("gateway_error", "The action gateway could not be reached.");
  }
}

async function readGatewayResponse(response: Response): Promise<GoatActionGatewayResponse> {
  try {
    const value = (await response.json()) as unknown;
    if (isRecord(value) && typeof value.ok === "boolean") {
      return value as GoatActionGatewayResponse;
    }
  } catch {
    // Never surface an HTML proxy response or internal URL to the model.
  }
  return gatewayError("gateway_error", `The action gateway returned HTTP ${response.status}.`);
}

function invalidAction(action: string): UseActionToolOutput {
  return {
    ok: false,
    action,
    error: {
      code: "invalid_params",
      message: `"${action}" is not an available action.`,
    },
  };
}

function gatewayError(code: string, message: string): GoatActionGatewayResponse {
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
