import {
  type ActionGatewayRequest,
  type ActionGatewayResponse,
  GOAT_ACTION_HOST_TOOL_CONTRACT_VERSIONS,
} from "@opencompany/agent-runtime";
import { projectActionCatalog } from "@opencompany/core/actions/policy";
import { serveActionRequest } from "@opencompany/core/actions/service";
import {
  claimActionAsyncRun,
  claimActionInvocation,
  getActionCapabilityTurnState,
  recordActionSourceDiscovery,
  releaseActionAsyncRun,
  releaseActionCapabilityQuote,
  storeActionCapabilityQuote,
} from "@opencompany/db/action-governance";
import { getDb } from "@opencompany/db/client";
import { codexChatSessions, codexChatTurns, users, workspaceMembers } from "@opencompany/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { isChatActionsKilled, resolveActionCatalog } from "@/lib/actions/catalog";
import { executeAction } from "@/lib/actions/execute";
import type {
  CapabilityQuote,
  CapabilityTurnState,
  ResolvedActionCatalog,
} from "@/lib/actions/types";

type ActionPrincipal = {
  userWorkosId: string;
  workspaceId: string;
  chatSessionId: string;
  userTimezone: string;
};

type ActionGatewayDependencies = {
  loadContext: (request: ActionGatewayRequest) => Promise<ActionPrincipal | null>;
  resolveCatalog: typeof resolveActionCatalog;
  executeAction: typeof executeAction;
  getCapabilityTurnState: (
    request: ActionGatewayRequest,
    context: ActionPrincipal,
  ) => CapabilityTurnState;
  recordSourceDiscovery: typeof recordActionSourceDiscovery;
  claimInvocation: typeof claimActionInvocation;
  now: () => Date;
};

const defaultDependencies: ActionGatewayDependencies = {
  loadContext: loadCodexActionContext,
  resolveCatalog: resolveActionCatalog,
  executeAction: executeAction,
  getCapabilityTurnState: getCodexActionCapabilityTurnState,
  recordSourceDiscovery: recordActionSourceDiscovery,
  claimInvocation: claimActionInvocation,
  now: () => new Date(),
};

export async function executeActionGateway(input: {
  request: ActionGatewayRequest;
  signal: AbortSignal;
  dependencies?: Partial<ActionGatewayDependencies>;
}): Promise<ActionGatewayResponse> {
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  if (isChatActionsKilled()) {
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
    return await serveActionRequest({
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

function getCodexActionCapabilityTurnState(
  request: ActionGatewayRequest,
  context: ActionPrincipal,
): CapabilityTurnState {
  const turn = actionTurnRef(request, context);
  return {
    quotedTotalUsdMicros: 0,
    admittedToolCallIds: [],
    quotesByToolCallId: new Map(),
    asyncRunsStarted: 0,
    governance: {
      load: async () => {
        const state = await getActionCapabilityTurnState({ turn });
        return {
          quotedTotalUsdMicros: state.quotedTotalUsdMicros,
          admittedToolCallIds: state.admittedInvocationIds,
          quotesByToolCallId: new Map(
            Object.entries(state.capabilityQuotes) as [string, CapabilityQuote][],
          ),
          asyncRunsStarted: state.asyncRunsStarted,
        };
      },
      storeQuote: ({ toolCallId, quote, admitted, maxQuotedTotalUsdMicros }) =>
        storeActionCapabilityQuote({
          turn,
          invocationId: toolCallId,
          quote,
          admitted,
          ...(maxQuotedTotalUsdMicros === undefined ? {} : { maxQuotedTotalUsdMicros }),
        }),
      releaseQuote: ({ toolCallId, quoteTotalCostUsdMicros }) =>
        releaseActionCapabilityQuote({
          turn,
          invocationId: toolCallId,
          quoteTotalCostUsdMicros,
        }),
      claimAsyncRun: ({ toolCallId, maxRuns }) =>
        claimActionAsyncRun({
          turn,
          invocationId: toolCallId,
          maxRuns,
        }),
      releaseAsyncRun: ({ toolCallId }) =>
        releaseActionAsyncRun({ turn, invocationId: toolCallId }),
    },
  };
}

async function loadCodexActionContext(
  request: ActionGatewayRequest,
): Promise<ActionPrincipal | null> {
  const [row] = await getDb()
    .select({
      userWorkosId: codexChatSessions.userWorkosId,
      workspaceId: codexChatSessions.workspaceId,
      chatSessionId: codexChatSessions.chatSessionId,
      userTimezone: users.timezone,
    })
    .from(codexChatSessions)
    .innerJoin(
      codexChatTurns,
      and(
        eq(codexChatTurns.id, request.turnId),
        eq(codexChatTurns.codexChatSessionId, codexChatSessions.id),
        eq(codexChatTurns.userWorkosId, codexChatSessions.userWorkosId),
      ),
    )
    .innerJoin(users, eq(users.workosUserId, codexChatSessions.userWorkosId))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, codexChatSessions.workspaceId),
        eq(workspaceMembers.userWorkosId, codexChatSessions.userWorkosId),
      ),
    )
    .where(
      and(
        eq(codexChatSessions.id, request.sessionId),
        inArray(codexChatSessions.hostToolContractVersion, [
          ...GOAT_ACTION_HOST_TOOL_CONTRACT_VERSIONS,
        ]),
        eq(codexChatTurns.status, "running"),
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

function gatewayError(code: string, message: string): ActionGatewayResponse {
  return { ok: false, error: { code, message } };
}

function actionTurnRef(request: ActionGatewayRequest, context: ActionPrincipal) {
  return {
    sessionId: request.sessionId,
    turnId: request.turnId,
    userWorkosId: context.userWorkosId,
    workspaceId: context.workspaceId,
    policy: "cloudReadOnly" as const,
  };
}
