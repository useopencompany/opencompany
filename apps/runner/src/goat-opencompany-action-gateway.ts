import {
  type GoatActionGatewayResponse,
  type GoatActionHostGatewayRequest,
} from "@opencompany/agent-runtime";
import { executeGoatActionHostGateway } from "@opencompany/goat-agent/application/persisted-action-gateway";
import type { ActionDispatcher } from "@opencompany/goat-agent/chat-agent";
import type { GoatChatActionCatalog, UseActionToolOutput } from "@opencompany/goat-agent/chat-ui";

type GatewayContext = {
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
  approvalContinuation: boolean;
};

type GatewayDependencies = { execute: typeof executeGoatActionHostGateway };

const defaultDependencies: GatewayDependencies = { execute: executeGoatActionHostGateway };

export async function createGoatOpenCompanyActionDispatcher(
  context: GatewayContext,
  dependencies: Partial<GatewayDependencies> = {},
): Promise<ActionDispatcher | null> {
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
  try {
    return await dependencies.execute({ request, signal: context.signal });
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason ?? error;
    return gatewayError("gateway_error", "The action service could not complete the request.");
  }
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
