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
import { and, eq, inArray } from "drizzle-orm";
import { isGoatChatActionsKilled, resolveGoatActionCatalog } from "../actions/catalog";
import { executeGoatAction } from "../actions/execute";
import type { GoatCapabilityQuote, GoatCapabilityTurnState } from "../actions/types";
import { MANAGED_CAPABILITY_ACTIONS_BY_ID } from "../capabilities/catalog";
import { evaluateManagedCapabilityApproval } from "../capabilities/execute";
import { resolveGoatManagedCapabilities } from "../capabilities/resolve";
import {
  executeGoatActionGatewayService,
  executeGoatActionHostGatewayService,
  type GoatActionGatewayServiceDependencies,
  type GoatActionPrincipal,
  type GoatActionServiceRequest,
  type GoatActionServiceRunRef,
} from "./action-gateway";

const defaultDependencies: GoatActionGatewayServiceDependencies = {
  actionsKilled: isGoatChatActionsKilled,
  loadContext: loadGoatCodexActionContext,
  resolveCatalog: ({ actorId, workspaceId }) =>
    resolveGoatActionCatalog(
      { userWorkosId: actorId, workspaceId },
      { resolveManagedCapabilities: resolveGoatManagedCapabilities },
    ),
  executeAction: ({ actorId, conversationId, ...input }) =>
    executeGoatAction({ ...input, userWorkosId: actorId, chatSessionId: conversationId }),
  getCapabilityTurnState: getGoatCodexActionCapabilityTurnState,
  recordSourceDiscovery: ({ run, sourceId }) =>
    recordGoatActionSourceDiscovery({ turn: actionTurnRef(run), sourceId }),
  claimInvocation: ({ run, ...input }) =>
    claimGoatActionInvocation({ turn: actionTurnRef(run), ...input }),
  evaluateApproval: evaluateGoatActionApproval,
  now: () => new Date(),
};

export function executeGoatActionGateway(input: {
  request: GoatActionGatewayRequest;
  signal: AbortSignal;
  dependencies?: Partial<GoatActionGatewayServiceDependencies>;
}): Promise<GoatActionGatewayResponse> {
  return executeGoatActionGatewayService({
    request: actionServiceRequest(input.request),
    signal: input.signal,
    dependencies: { ...defaultDependencies, ...input.dependencies },
  });
}

export function executeGoatActionHostGateway(input: {
  request: GoatActionHostGatewayRequest;
  signal: AbortSignal;
  dependencies?: Partial<GoatActionGatewayServiceDependencies>;
}): Promise<GoatActionGatewayResponse> {
  return executeGoatActionHostGatewayService({
    request: actionServiceRequest(input.request),
    signal: input.signal,
    dependencies: { ...defaultDependencies, ...input.dependencies },
  });
}

async function evaluateGoatActionApproval(input: {
  request: Extract<GoatActionServiceRequest, { operation: "approval" }>;
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
    userWorkosId: input.context.actorId,
    chatSessionId: input.context.conversationId,
    turnState: input.turnState,
    signal: input.signal,
  });
}

function getGoatCodexActionCapabilityTurnState(
  request: GoatActionServiceRequest,
  context: GoatActionPrincipal,
): GoatCapabilityTurnState {
  const turn = actionTurnRef({
    sessionId: request.sessionId,
    runId: request.runId,
    actorId: context.actorId,
    workspaceId: context.workspaceId,
    policy: context.policy ?? "cloudReadOnly",
  });
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
        claimGoatActionAsyncRun({ turn, invocationId: toolCallId, maxRuns }),
      releaseAsyncRun: ({ toolCallId }) =>
        releaseGoatActionAsyncRun({ turn, invocationId: toolCallId }),
    },
  };
}

async function loadGoatCodexActionContext(
  request: GoatActionServiceRequest,
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
        eq(goatCodexChatTurns.id, request.runId),
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
    actorId: row.userWorkosId,
    workspaceId: row.workspaceId,
    conversationId: row.chatSessionId,
    userTimezone: row.userTimezone,
    policy: row.engine === "opencompany" ? "foregroundInteractive" : "cloudReadOnly",
  };
}

function actionTurnRef(run: GoatActionServiceRunRef) {
  return {
    sessionId: run.sessionId,
    turnId: run.runId,
    userWorkosId: run.actorId,
    workspaceId: run.workspaceId,
    policy: run.policy,
  };
}

function actionServiceRequest(
  request: GoatActionGatewayRequest,
): Extract<GoatActionServiceRequest, { operation: "list" | "execute" }>;
function actionServiceRequest(request: GoatActionHostGatewayRequest): GoatActionServiceRequest;
function actionServiceRequest(request: GoatActionHostGatewayRequest): GoatActionServiceRequest {
  const { turnId, ...input } = request;
  return { ...input, runId: turnId } as GoatActionServiceRequest;
}
