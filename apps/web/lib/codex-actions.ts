import {
  GOAT_ACTION_HOST_TOOL_CONTRACT_VERSIONS,
  GOAT_CHAT_HOST_TOOL_CONTRACT_VERSION,
  type GoatActionGatewayRequest,
  type GoatActionGatewayResponse,
  type GoatActionHostGatewayRequest,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  claimGoatActionAsyncRun,
  claimGoatActionInvocation,
  getGoatActionCapabilityTurnState,
  recordGoatActionSourceDiscovery,
  releaseGoatActionAsyncRun,
  releaseGoatActionCapabilityQuote,
  storeGoatActionCapabilityQuote,
} from "@opencompany/db/goat-action-governance";
import {
  goatCodexChatSessions,
  goatCodexChatTurns,
  goatUsers,
  goatWorkspaceMembers,
} from "@opencompany/db/goat-schema";
import {
  type GoatActionCatalogPolicyName,
  projectActionCatalog,
} from "@opencompany/goat-agent/actions/policy";
import { serveGoatActionRequest } from "@opencompany/goat-agent/actions/service";
import { and, eq, inArray } from "drizzle-orm";
import { isGoatChatActionsKilled, resolveGoatActionCatalog } from "@/lib/actions/catalog";
import { executeGoatAction } from "@/lib/actions/execute";
import type {
  GoatCapabilityQuote,
  GoatCapabilityTurnState,
  GoatResolvedActionCatalog,
} from "@/lib/actions/types";
import { MANAGED_CAPABILITY_ACTIONS_BY_ID } from "@/lib/capabilities/catalog";
import { evaluateManagedCapabilityApproval } from "@/lib/capabilities/execute";

type GoatActionPrincipal = {
  userWorkosId: string;
  workspaceId: string;
  chatSessionId: string;
  userTimezone: string;
  policy?: GoatActionCatalogPolicyName;
};

type GoatActionGatewayDependencies = {
  loadContext: (request: GoatActionHostGatewayRequest) => Promise<GoatActionPrincipal | null>;
  resolveCatalog: typeof resolveGoatActionCatalog;
  executeAction: typeof executeGoatAction;
  getCapabilityTurnState: (
    request: GoatActionHostGatewayRequest,
    context: GoatActionPrincipal,
  ) => GoatCapabilityTurnState;
  recordSourceDiscovery: typeof recordGoatActionSourceDiscovery;
  claimInvocation: typeof claimGoatActionInvocation;
  evaluateApproval: (input: {
    request: Extract<GoatActionHostGatewayRequest, { operation: "approval" }>;
    context: GoatActionPrincipal;
    turnState: GoatCapabilityTurnState;
    signal: AbortSignal;
  }) => Promise<boolean>;
  now: () => Date;
};

const defaultDependencies: GoatActionGatewayDependencies = {
  loadContext: loadGoatCodexActionContext,
  resolveCatalog: resolveGoatActionCatalog,
  executeAction: executeGoatAction,
  getCapabilityTurnState: getGoatCodexActionCapabilityTurnState,
  recordSourceDiscovery: recordGoatActionSourceDiscovery,
  claimInvocation: claimGoatActionInvocation,
  evaluateApproval: evaluateGoatActionApproval,
  now: () => new Date(),
};

export function executeGoatActionGateway(input: {
  request: GoatActionGatewayRequest;
  signal: AbortSignal;
  dependencies?: Partial<GoatActionGatewayDependencies>;
}): Promise<GoatActionGatewayResponse> {
  return executeGoatActionHostGateway(input);
}

export async function executeGoatActionHostGateway(input: {
  request: GoatActionHostGatewayRequest;
  signal: AbortSignal;
  dependencies?: Partial<GoatActionGatewayDependencies>;
}): Promise<GoatActionGatewayResponse> {
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  if (isGoatChatActionsKilled()) {
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
        userWorkosId: context.userWorkosId,
        workspaceId: context.workspaceId,
      }),
      context.policy ?? "cloudReadOnly",
    );
  } catch {
    return gatewayError("internal", "The action catalog could not be loaded.");
  }

  const turn = actionTurnRef(input.request, context);
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
      await dependencies.recordSourceDiscovery({ turn, sourceId: action.provider });
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
      request: input.request,
      catalog: serviceCatalog,
      governance: {
        recordSourceDiscovery: (sourceId) => dependencies.recordSourceDiscovery({ turn, sourceId }),
        claimInvocation: ({ sourceId, invocationId, maxCalls }) =>
          dependencies.claimInvocation({
            turn,
            sourceId,
            invocationId,
            maxCalls,
          }),
      },
      execute: ({ action, params, invocationId }) =>
        dependencies.executeAction({
          catalog,
          actionId: action,
          params,
          userWorkosId: context.userWorkosId,
          workspaceId: context.workspaceId,
          chatSessionId: context.chatSessionId,
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

async function evaluateGoatActionApproval(input: {
  request: Extract<GoatActionHostGatewayRequest, { operation: "approval" }>;
  context: GoatActionPrincipal;
  turnState: GoatCapabilityTurnState;
  signal: AbortSignal;
}) {
  const spec = MANAGED_CAPABILITY_ACTIONS_BY_ID.get(input.request.action);
  if (!spec) return false;
  return evaluateManagedCapabilityApproval({
    spec,
    params: input.request.params,
    toolCallId: input.request.invocationId,
    workspaceId: input.context.workspaceId,
    userWorkosId: input.context.userWorkosId,
    chatSessionId: input.context.chatSessionId,
    turnState: input.turnState,
    signal: input.signal,
  });
}

function getGoatCodexActionCapabilityTurnState(
  request: GoatActionHostGatewayRequest,
  context: GoatActionPrincipal,
): GoatCapabilityTurnState {
  const turn = actionTurnRef(request, context);
  return {
    quotedTotalUsdMicros: 0,
    admittedToolCallIds: [],
    quotesByToolCallId: new Map(),
    asyncRunsStarted: 0,
    governance: {
      load: async () => {
        const state = await getGoatActionCapabilityTurnState({ turn });
        return {
          quotedTotalUsdMicros: state.quotedTotalUsdMicros,
          admittedToolCallIds: state.admittedInvocationIds,
          quotesByToolCallId: new Map(
            Object.entries(state.capabilityQuotes) as [string, GoatCapabilityQuote][],
          ),
          asyncRunsStarted: state.asyncRunsStarted,
        };
      },
      storeQuote: ({ toolCallId, quote, admitted, maxQuotedTotalUsdMicros }) =>
        storeGoatActionCapabilityQuote({
          turn,
          invocationId: toolCallId,
          quote,
          admitted,
          ...(maxQuotedTotalUsdMicros === undefined ? {} : { maxQuotedTotalUsdMicros }),
        }),
      releaseQuote: ({ toolCallId, quoteTotalCostUsdMicros }) =>
        releaseGoatActionCapabilityQuote({
          turn,
          invocationId: toolCallId,
          quoteTotalCostUsdMicros,
        }),
      claimAsyncRun: ({ toolCallId, maxRuns }) =>
        claimGoatActionAsyncRun({
          turn,
          invocationId: toolCallId,
          maxRuns,
        }),
      releaseAsyncRun: ({ toolCallId }) =>
        releaseGoatActionAsyncRun({ turn, invocationId: toolCallId }),
    },
  };
}

async function loadGoatCodexActionContext(
  request: GoatActionHostGatewayRequest,
): Promise<GoatActionPrincipal | null> {
  const [row] = await getDb()
    .select({
      userWorkosId: goatCodexChatSessions.userWorkosId,
      workspaceId: goatCodexChatSessions.workspaceId,
      chatSessionId: goatCodexChatSessions.chatSessionId,
      userTimezone: goatUsers.timezone,
      engine: goatCodexChatSessions.engine,
    })
    .from(goatCodexChatSessions)
    .innerJoin(
      goatCodexChatTurns,
      and(
        eq(goatCodexChatTurns.id, request.turnId),
        eq(goatCodexChatTurns.codexChatSessionId, goatCodexChatSessions.id),
        eq(goatCodexChatTurns.userWorkosId, goatCodexChatSessions.userWorkosId),
      ),
    )
    .innerJoin(goatUsers, eq(goatUsers.workosUserId, goatCodexChatSessions.userWorkosId))
    .innerJoin(
      goatWorkspaceMembers,
      and(
        eq(goatWorkspaceMembers.workspaceId, goatCodexChatSessions.workspaceId),
        eq(goatWorkspaceMembers.userWorkosId, goatCodexChatSessions.userWorkosId),
      ),
    )
    .where(
      and(
        eq(goatCodexChatSessions.id, request.sessionId),
        inArray(goatCodexChatSessions.hostToolContractVersion, [
          ...GOAT_ACTION_HOST_TOOL_CONTRACT_VERSIONS,
          GOAT_CHAT_HOST_TOOL_CONTRACT_VERSION,
        ]),
        eq(goatCodexChatTurns.status, "running"),
      ),
    )
    .limit(1);

  if (!row?.workspaceId) return null;
  return {
    userWorkosId: row.userWorkosId,
    workspaceId: row.workspaceId,
    chatSessionId: row.chatSessionId,
    userTimezone: row.userTimezone,
    policy: row.engine === "opencompany" ? "foregroundInteractive" : "cloudReadOnly",
  };
}

function gatewayError(code: string, message: string): GoatActionGatewayResponse {
  return { ok: false, error: { code, message } };
}

function actionTurnRef(request: GoatActionHostGatewayRequest, context: GoatActionPrincipal) {
  return {
    sessionId: request.sessionId,
    turnId: request.turnId,
    userWorkosId: context.userWorkosId,
    workspaceId: context.workspaceId,
    policy: context.policy ?? "cloudReadOnly",
  };
}
