import type {
  ActionGatewayRequest,
  ActionGatewayResponse,
  ActionHostGatewayRequest,
} from "@opencompany/agent-runtime";
import { type ActionCatalogPolicyName, projectActionCatalog } from "../actions/policy";
import { type ActionInvocationClaim, serveActionRequest } from "../actions/service";
import type { CapabilityTurnState, ResolvedActionCatalog } from "../actions/types";

export type ActionPrincipal = {
  actorId: string;
  workspaceId: string;
  conversationId: string;
  userTimezone: string;
  policy?: ActionCatalogPolicyName;
};

export type ActionServiceRunRef = {
  sessionId: string;
  runId: string;
  actorId: string;
  workspaceId: string;
  policy: ActionCatalogPolicyName;
};

type WithRunId<T> = T extends { turnId: string } ? Omit<T, "turnId"> & { runId: string } : never;

export type ActionServiceRequest = WithRunId<ActionHostGatewayRequest>;

export type ActionGatewayServiceDependencies = {
  actionsKilled: () => boolean;
  loadContext: (request: ActionServiceRequest) => Promise<ActionPrincipal | null>;
  resolveCatalog: (input: {
    actorId: string;
    workspaceId: string;
  }) => Promise<ResolvedActionCatalog>;
  executeAction: (input: {
    catalog: ResolvedActionCatalog;
    actionId: string;
    params: Record<string, unknown>;
    actorId: string;
    workspaceId: string;
    conversationId: string;
    toolCallId: string;
    capabilityTurnState: CapabilityTurnState;
    signal: AbortSignal;
    currentDate: Date;
    userTimezone: string;
  }) => Promise<ActionGatewayResponse>;
  getCapabilityTurnState: (
    request: ActionServiceRequest,
    context: ActionPrincipal,
  ) => CapabilityTurnState;
  recordSourceDiscovery: (input: { run: ActionServiceRunRef; sourceId: string }) => Promise<void>;
  claimInvocation: (input: {
    run: ActionServiceRunRef;
    sourceId: string;
    invocationId: string;
    maxCalls: number;
  }) => Promise<ActionInvocationClaim>;
  evaluateApproval: (input: {
    request: Extract<ActionServiceRequest, { operation: "approval" }>;
    context: ActionPrincipal;
    turnState: CapabilityTurnState;
    signal: AbortSignal;
  }) => Promise<boolean>;
  now: () => Date;
};

export function executeActionGatewayService(input: {
  request: Extract<ActionServiceRequest, { operation: "list" | "execute" }>;
  signal: AbortSignal;
  dependencies: ActionGatewayServiceDependencies;
}): Promise<ActionGatewayResponse> {
  return executeActionHostGatewayService(input);
}

export async function executeActionHostGatewayService(input: {
  request: ActionServiceRequest;
  signal: AbortSignal;
  dependencies: ActionGatewayServiceDependencies;
}): Promise<ActionGatewayResponse> {
  const { dependencies } = input;
  if (dependencies.actionsKilled()) {
    return gatewayError("disabled", "Actions are temporarily disabled.");
  }

  const context = await dependencies.loadContext(input.request);
  if (!context) {
    return gatewayError("not_permitted", "This turn can no longer access actions.");
  }

  let catalog: ResolvedActionCatalog;
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
    return await serveActionRequest({
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

function gatewayError(code: string, message: string): ActionGatewayResponse {
  return { ok: false, error: { code, message } };
}

function actionRunRef(request: ActionServiceRequest, context: ActionPrincipal) {
  return {
    sessionId: request.sessionId,
    runId: request.runId,
    actorId: context.actorId,
    workspaceId: context.workspaceId,
    policy: context.policy ?? "cloudReadOnly",
  };
}

function gatewayRequest(request: ActionServiceRequest): ActionGatewayRequest {
  if (request.operation !== "list" && request.operation !== "execute") {
    throw new Error("Only list and execute requests can reach the action executor.");
  }
  const { runId, ...input } = request;
  return { ...input, turnId: runId };
}
