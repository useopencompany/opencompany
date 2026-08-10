import {
  GOAT_ACTION_HOST_TOOL_CONTRACT_VERSIONS,
  type GoatActionGatewayRequest,
  type GoatActionGatewayResponse,
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
import { projectActionCatalog } from "@opencompany/goat-agent/actions/policy";
import { serveGoatActionRequest } from "@opencompany/goat-agent/actions/service";
import { and, eq, inArray } from "drizzle-orm";
import { isGoatChatActionsKilled, resolveGoatActionCatalog } from "@/lib/actions/catalog";
import { executeGoatAction } from "@/lib/actions/execute";
import type {
  GoatCapabilityQuote,
  GoatCapabilityTurnState,
  GoatResolvedActionCatalog,
} from "@/lib/actions/types";

type GoatActionPrincipal = {
  userWorkosId: string;
  workspaceId: string;
  chatSessionId: string;
  userTimezone: string;
};

type GoatActionGatewayDependencies = {
  loadContext: (request: GoatActionGatewayRequest) => Promise<GoatActionPrincipal | null>;
  resolveCatalog: typeof resolveGoatActionCatalog;
  executeAction: typeof executeGoatAction;
  getCapabilityTurnState: (
    request: GoatActionGatewayRequest,
    context: GoatActionPrincipal,
  ) => GoatCapabilityTurnState;
  recordSourceDiscovery: typeof recordGoatActionSourceDiscovery;
  claimInvocation: typeof claimGoatActionInvocation;
  now: () => Date;
};

const defaultDependencies: GoatActionGatewayDependencies = {
  loadContext: loadGoatCodexActionContext,
  resolveCatalog: resolveGoatActionCatalog,
  executeAction: executeGoatAction,
  getCapabilityTurnState: getGoatCodexActionCapabilityTurnState,
  recordSourceDiscovery: recordGoatActionSourceDiscovery,
  claimInvocation: claimGoatActionInvocation,
  now: () => new Date(),
};

export async function executeGoatActionGateway(input: {
  request: GoatActionGatewayRequest;
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
      "cloudReadOnly",
    );
  } catch {
    return gatewayError("internal", "The action catalog could not be loaded.");
  }

  const turn = actionTurnRef(input.request, context);
  try {
    return await serveGoatActionRequest({
      request: input.request,
      catalog: {
        sources: catalog.providers,
        actions: catalog.actions.map((action) => ({
          id: action.id,
          source: action.provider,
          description: action.description,
          params: action.params,
          permissionMode: action.permissionMode,
        })),
      },
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

function getGoatCodexActionCapabilityTurnState(
  request: GoatActionGatewayRequest,
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
  request: GoatActionGatewayRequest,
): Promise<GoatActionPrincipal | null> {
  const [row] = await getDb()
    .select({
      userWorkosId: goatCodexChatSessions.userWorkosId,
      workspaceId: goatCodexChatSessions.workspaceId,
      chatSessionId: goatCodexChatSessions.chatSessionId,
      userTimezone: goatUsers.timezone,
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
  };
}

function gatewayError(code: string, message: string): GoatActionGatewayResponse {
  return { ok: false, error: { code, message } };
}

function actionTurnRef(request: GoatActionGatewayRequest, context: GoatActionPrincipal) {
  return {
    sessionId: request.sessionId,
    turnId: request.turnId,
    userWorkosId: context.userWorkosId,
    workspaceId: context.workspaceId,
    policy: "cloudReadOnly" as const,
  };
}
