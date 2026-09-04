import { executeActionHostGateway } from "@opencompany/agent/application/persisted-action-gateway";
import type { ActionDispatcher } from "@opencompany/agent/chat-agent";
import type { ChatActionCatalog, UseActionToolOutput } from "@opencompany/agent/chat-ui";
import {
  type ActionGatewayResponse,
  type ActionHostGatewayRequest,
} from "@opencompany/agent-runtime";
import { createLogger } from "@opencompany/observability";

type GatewayContext = {
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
  approvalContinuation: boolean;
  prelistedSourceIds?: readonly string[];
};

type GatewayDependencies = { execute: typeof executeActionHostGateway };

const defaultDependencies: GatewayDependencies = { execute: executeActionHostGateway };

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-opencompany-action-gateway",
});

export async function createActionDispatcher(
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

  const catalog = response.catalog as ChatActionCatalog;
  const sourceByAction = new Map(catalog.actions.map((action) => [action.id, action.source]));
  const availableSourceIds = new Set<string>(catalog.sources.map((source) => source.id));
  const prelistedSourceIds = context.approvalContinuation
    ? [...availableSourceIds]
    : (context.prelistedSourceIds ?? []).filter((sourceId) => availableSourceIds.has(sourceId));
  const approvalFailures = new Map<string, UseActionToolOutput>();

  return {
    catalog,
    ...(prelistedSourceIds.length > 0 ? { prelistedSourceIds } : {}),
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
        const approvalError = approval.ok
          ? { code: "invalid_gateway_response", message: "Approval response was missing." }
          : approval.error;
        const failure = approvalEvaluationFailure({
          action,
          source: sourceByAction.get(action),
        });
        approvalFailures.set(toolCallId, failure);
        logger.error("Action approval could not be evaluated", {
          event: "opencompany.action_gateway_approval_evaluation_failed",
          operation: "approval",
          action_id: action,
          invocation_id: toolCallId,
          error: approvalError,
        });
        return false;
      }
      return approval.needsApproval;
    },
    execute: async ({ action, params, toolCallId }) => {
      const approvalFailure = approvalFailures.get(toolCallId);
      if (approvalFailure) {
        approvalFailures.delete(toolCallId);
        return approvalFailure;
      }
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

function gatewayRequest<T extends Omit<ActionHostGatewayRequest, "sessionId" | "turnId">>(
  context: GatewayContext,
  request: T,
): ActionHostGatewayRequest {
  return {
    ...request,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as ActionHostGatewayRequest;
}

async function callGateway(
  context: GatewayContext,
  dependencies: GatewayDependencies,
  request: ActionHostGatewayRequest,
): Promise<ActionGatewayResponse> {
  try {
    return await dependencies.execute({ request, signal: context.signal });
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason ?? error;
    logger.error("Action gateway request failed", {
      event: "opencompany.action_gateway_request_failed",
      operation: request.operation,
      action_id: "action" in request ? request.action : undefined,
      invocation_id: "invocationId" in request ? request.invocationId : undefined,
      error,
    });
    return gatewayError("gateway_error", "The action service could not complete the request.");
  }
}

function approvalEvaluationFailure(input: {
  action: string;
  source: ChatActionCatalog["sources"][number]["id"] | undefined;
}): UseActionToolOutput {
  return {
    ok: false,
    action: input.action,
    error: {
      code: "internal",
      ...(input.source ? { source: input.source } : {}),
      message: `Approval for ${JSON.stringify(input.action)} could not be evaluated, so the action was not run.`,
    },
  };
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

function gatewayError(code: string, message: string): ActionGatewayResponse {
  return { ok: false, error: { code, message } };
}
