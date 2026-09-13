import {
  ACTION_HOST_TOOL_CONTRACT_VERSION,
  type ActionGatewayRequest,
  type ActionGatewayResponse,
  type ActionHostGatewayRequest,
  supportsCompactActionDiscovery,
} from "@opencompany/agent-runtime";
import { actionApprovalInputHash } from "@opencompany/db/action-governance";
import type { CodexChatEngine } from "@opencompany/db/product-schema";
import { createLogger } from "@opencompany/observability";
import { type ActionCatalogPolicyName, projectActionCatalog } from "../actions/policy";
import { type ActionInvocationClaim, serveActionRequest } from "../actions/service";
import type { CapabilityTurnState, ResolvedActionCatalog } from "../actions/types";

const logger = createLogger({ service: "opencompany-agent", runtime: "action-gateway" });

export type ActionPrincipal = {
  durableTaskApprovals?: boolean;
  hostToolContractVersion?: string;
  actorId: string;
  workspaceId: string;
  conversationId: string;
  userTimezone: string;
  engine?: CodexChatEngine;
  assistantMessageId?: string;
  policy?: ActionCatalogPolicyName;
};

export type ActionServiceRunRef = {
  sessionId: string;
  runId: string;
  actorId: string;
  workspaceId: string;
  policy: ActionCatalogPolicyName;
};

export type ActionGatewayApprovalRecord = {
  actionId: string;
  sourceId: string;
  capabilityId: string;
  inputHash: string;
  status: "pending" | "approved" | "denied";
};

type WithRunId<T> = T extends { turnId: string } ? Omit<T, "turnId"> & { runId: string } : never;

export type ActionServiceRequest = WithRunId<ActionHostGatewayRequest>;

export type ActionGatewayServiceDependencies = {
  actionsKilled: () => boolean;
  loadContext: (request: ActionServiceRequest) => Promise<ActionPrincipal | null>;
  resolveCatalog: (input: {
    conversationId?: string;
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
    sourceTurnId?: string;
    sourceMessageId?: string;
    sourceEngine?: CodexChatEngine;
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
    deduplicationKey?: string;
  }) => Promise<ActionInvocationClaim>;
  registerApproval: (input: {
    run: ActionServiceRunRef;
    invocationId: string;
    actionId: string;
    sourceId: string;
    capabilityId: string;
    params: Record<string, unknown>;
    decision?: "pending" | "denied";
    approvalContext?: string;
  }) => Promise<ActionGatewayApprovalRecord | null>;
  evaluateApproval: (input: {
    request: Extract<ActionServiceRequest, { operation: "approval" }>;
    context: ActionPrincipal;
    turnState: CapabilityTurnState;
    signal: AbortSignal;
  }) => Promise<boolean>;
  now: () => Date;
};

export function executeActionGatewayService(input: {
  request: Extract<ActionServiceRequest, { operation: "list" | "describe" | "execute" }>;
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
        ...(context.policy === "headless" ? {} : { conversationId: context.conversationId }),
        actorId: context.actorId,
        workspaceId: context.workspaceId,
      }),
      context.policy ?? "foregroundInteractive",
    );
  } catch {
    return gatewayError("internal", "The action catalog could not be loaded.");
  }

  const run = actionRunRef(input.request, context);
  const denyHeadlessApproval = run.policy === "headless" && !context.durableTaskApprovals;
  try {
    const serviceCatalog = {
      sources: catalog.providers.map(({ id, kind, label, description }) => ({
        id,
        kind: kind ?? "integration",
        label,
        description,
      })),
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
      if (action.permissionMode === "ask") {
        const approval = await dependencies.registerApproval({
          run,
          invocationId: approvalRequest.invocationId,
          actionId: action.id,
          sourceId: action.provider,
          capabilityId: action.capability,
          params: approvalRequest.params,
          ...(action.approvalContext ? { approvalContext: action.approvalContext } : {}),
          ...(denyHeadlessApproval ? { decision: "denied" as const } : {}),
        });
        if (!approval) {
          return gatewayError(
            "invalid_params",
            "This action invocation does not match its existing approval request.",
          );
        }
        return {
          ok: true,
          needsApproval: !denyHeadlessApproval && approval.status === "pending",
        };
      }
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
    if (input.request.operation === "execute") {
      const executeRequest = input.request;
      const action = catalog.actions.find((candidate) => candidate.id === executeRequest.action);
      if (action?.permissionMode === "ask") {
        const approval = await dependencies.registerApproval({
          run,
          invocationId: executeRequest.invocationId,
          actionId: action.id,
          sourceId: action.provider,
          capabilityId: action.capability,
          params: executeRequest.params,
          ...(action.approvalContext ? { approvalContext: action.approvalContext } : {}),
          ...(denyHeadlessApproval ? { decision: "denied" as const } : {}),
        });
        if (!approval) {
          return gatewayError(
            "invalid_params",
            "This action invocation does not match its existing approval request.",
          );
        }
        if (approval.status === "pending") {
          return {
            ok: false,
            action: action.id,
            error: {
              code: "approval_required",
              source: action.provider,
              message: `Approval is required before ${JSON.stringify(action.id)} can run.`,
            },
          };
        }
        if (approval.status === "denied") {
          return {
            ok: false,
            action: action.id,
            error: {
              code: "not_permitted",
              source: action.provider,
              message: denyHeadlessApproval
                ? `Headless turns cannot approve ${JSON.stringify(action.id)}, so it was denied.`
                : `The user denied approval for ${JSON.stringify(action.id)}.`,
            },
          };
        }
      }
    }
    return await serveActionRequest({
      request: gatewayRequest(input.request),
      catalog: serviceCatalog,
      legacyDiscovery: !supportsCompactActionDiscovery(
        context.hostToolContractVersion ?? ACTION_HOST_TOOL_CONTRACT_VERSION,
      ),
      governance: {
        recordSourceDiscovery: (sourceId) => dependencies.recordSourceDiscovery({ run, sourceId }),
        claimInvocation: ({ sourceId, invocationId, maxCalls }) => {
          const request = input.request;
          const action =
            request.operation === "execute"
              ? catalog.actions.find((candidate) => candidate.id === request.action)
              : undefined;
          // Model-generated call ids change when an approval continuation repeats a write.
          // The durable, atomic turn claim must identify the operation independently of those
          // ids. Keep the original call id for approval binding and provider result correlation.
          const deduplicationKey =
            action?.effects.mutatesExternalSystem &&
            !action.effects.idempotent &&
            request.operation === "execute"
              ? `write:${actionApprovalInputHash({ action: action.id, source: action.provider, params: request.params }, action.approvalContext)}`
              : undefined;
          return dependencies.claimInvocation({
            run,
            sourceId,
            invocationId,
            maxCalls,
            ...(deduplicationKey ? { deduplicationKey } : {}),
          });
        },
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
          sourceTurnId: input.request.runId,
          ...(context.assistantMessageId ? { sourceMessageId: context.assistantMessageId } : {}),
          ...(context.engine ? { sourceEngine: context.engine } : {}),
        }),
    });
  } catch (error) {
    logger.error("Action gateway service request failed", {
      event: "opencompany.action_gateway_service_request_failed",
      operation: input.request.operation,
      action_id: "action" in input.request ? input.request.action : undefined,
      invocation_id: "invocationId" in input.request ? input.request.invocationId : undefined,
      error,
    });
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
    policy: context.policy ?? "foregroundInteractive",
  };
}

function gatewayRequest(request: ActionServiceRequest): ActionGatewayRequest {
  if (
    request.operation !== "list" &&
    request.operation !== "describe" &&
    request.operation !== "execute"
  ) {
    throw new Error("Only list, describe, and execute requests can reach the action executor.");
  }
  const { runId, ...input } = request;
  return { ...input, turnId: runId };
}
