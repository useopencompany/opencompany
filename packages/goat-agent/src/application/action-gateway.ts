import type {
  GoatActionGatewayRequest,
  GoatActionGatewayResponse,
  GoatActionHostGatewayRequest,
} from "@opencompany/agent-runtime";
import { type GoatActionCatalogPolicyName, projectActionCatalog } from "../actions/policy";
import { type GoatActionInvocationClaim, serveGoatActionRequest } from "../actions/service";
import type { GoatCapabilityTurnState, GoatResolvedActionCatalog } from "../actions/types";

export type GoatActionPrincipal = {
  actorId: string;
  workspaceId: string;
  conversationId: string;
  userTimezone: string;
  policy?: GoatActionCatalogPolicyName;
};

export type GoatActionServiceRunRef = {
  sessionId: string;
  runId: string;
  actorId: string;
  workspaceId: string;
  policy: GoatActionCatalogPolicyName;
};

type WithRunId<T> = T extends { turnId: string } ? Omit<T, "turnId"> & { runId: string } : never;

export type GoatActionServiceRequest = WithRunId<GoatActionHostGatewayRequest>;

export type GoatActionGatewayServiceDependencies = {
  actionsKilled: () => boolean;
  loadContext: (request: GoatActionServiceRequest) => Promise<GoatActionPrincipal | null>;
  resolveCatalog: (input: {
    actorId: string;
    workspaceId: string;
  }) => Promise<GoatResolvedActionCatalog>;
  executeAction: (input: {
    catalog: GoatResolvedActionCatalog;
    actionId: string;
    params: Record<string, unknown>;
    actorId: string;
    workspaceId: string;
    conversationId: string;
    toolCallId: string;
    capabilityTurnState: GoatCapabilityTurnState;
    signal: AbortSignal;
    currentDate: Date;
    userTimezone: string;
  }) => Promise<GoatActionGatewayResponse>;
  getCapabilityTurnState: (
    request: GoatActionServiceRequest,
    context: GoatActionPrincipal,
  ) => GoatCapabilityTurnState;
  recordSourceDiscovery: (input: {
    run: GoatActionServiceRunRef;
    sourceId: string;
  }) => Promise<void>;
  claimInvocation: (input: {
    run: GoatActionServiceRunRef;
    sourceId: string;
    invocationId: string;
    maxCalls: number;
  }) => Promise<GoatActionInvocationClaim>;
  evaluateApproval: (input: {
    request: Extract<GoatActionServiceRequest, { operation: "approval" }>;
    context: GoatActionPrincipal;
    turnState: GoatCapabilityTurnState;
    signal: AbortSignal;
  }) => Promise<boolean>;
  now: () => Date;
};

export function executeGoatActionGatewayService(input: {
  request: Extract<GoatActionServiceRequest, { operation: "list" | "execute" }>;
  signal: AbortSignal;
  dependencies: GoatActionGatewayServiceDependencies;
}): Promise<GoatActionGatewayResponse> {
  return executeGoatActionHostGatewayService(input);
}

export async function executeGoatActionHostGatewayService(input: {
  request: GoatActionServiceRequest;
  signal: AbortSignal;
  dependencies: GoatActionGatewayServiceDependencies;
}): Promise<GoatActionGatewayResponse> {
  const { dependencies } = input;
  if (dependencies.actionsKilled()) {
    return gatewayError("disabled", "Actions are temporarily disabled.");
  }

  const context = await dependencies.loadContext(input.request);
  if (!context) {
    return gatewayError("not_permitted", "This turn can no longer access actions.");
  }

  let catalog: GoatResolvedActionCatalog;
  try {
    catalog = projectActionCatalog(
      await dependencies.resolveCatalog({
        actorId: context.actorId,
        workspaceId: context.workspaceId,
      }),
      context.policy ?? "cloudReadOnly",
    );
  } catch {
    return gatewayError("internal", "The action catalog could not be loaded.");
  }

  const run = actionRunRef(input.request, context);
  try {
    const serviceCatalog = {
      sources: catalog.providers,
      actions: catalog.actions.map((action) => ({
        id: action.id,
        source: action.provider,
        description: action.description,
        params: action.params,
        permissionMode: action.permissionMode,
      })),
    };
    if (input.request.operation === "catalog") {
      return { ok: true, catalog: serviceCatalog };
    }
    if (input.request.operation === "approval") {
      const approvalRequest = input.request;
      const action = catalog.actions.find((candidate) => candidate.id === approvalRequest.action);
      if (!action) {
        return gatewayError(
          "invalid_params",
          `"${approvalRequest.action}" is not an available action.`,
        );
      }
      if (action.permissionMode === "ask") return { ok: true, needsApproval: true };
      await dependencies.recordSourceDiscovery({ run, sourceId: action.provider });
      return {
        ok: true,
        needsApproval: await dependencies.evaluateApproval({
          request: approvalRequest,
          context,
          turnState: dependencies.getCapabilityTurnState(input.request, context),
          signal: input.signal,
        }),
      };
    }
    return await serveGoatActionRequest({
      request: gatewayRequest(input.request),
      catalog: serviceCatalog,
      governance: {
        recordSourceDiscovery: (sourceId) => dependencies.recordSourceDiscovery({ run, sourceId }),
        claimInvocation: ({ sourceId, invocationId, maxCalls }) =>
          dependencies.claimInvocation({ run, sourceId, invocationId, maxCalls }),
      },
      execute: ({ action, params, invocationId }) =>
        dependencies.executeAction({
          catalog,
          actionId: action,
          params,
          actorId: context.actorId,
          workspaceId: context.workspaceId,
          conversationId: context.conversationId,
          toolCallId: invocationId,
          capabilityTurnState: dependencies.getCapabilityTurnState(input.request, context),
          signal: input.signal,
          currentDate: dependencies.now(),
          userTimezone: context.userTimezone,
        }),
    });
  } catch {
    return gatewayError("internal", "The action request could not be completed.");
  }
}

function gatewayError(code: string, message: string): GoatActionGatewayResponse {
  return { ok: false, error: { code, message } };
}

function actionRunRef(request: GoatActionServiceRequest, context: GoatActionPrincipal) {
  return {
    sessionId: request.sessionId,
    runId: request.runId,
    actorId: context.actorId,
    workspaceId: context.workspaceId,
    policy: context.policy ?? "cloudReadOnly",
  };
}

function gatewayRequest(request: GoatActionServiceRequest): GoatActionGatewayRequest {
  if (request.operation !== "list" && request.operation !== "execute") {
    throw new Error("Only list and execute requests can reach the action executor.");
  }
  const { runId, ...input } = request;
  return { ...input, turnId: runId };
}
