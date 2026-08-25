import {
  ACTION_HOST_TOOL_CONTRACT_VERSIONS,
  type ActionGatewayRequest,
  type ActionGatewayResponse,
  type ActionHostGatewayRequest,
  CHAT_HOST_TOOL_CONTRACT_VERSION,
} from "@opencompany/agent-runtime";
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
import {
  codexChatSessions,
  codexChatTurns,
  users,
  workspaceMembers,
} from "@opencompany/db/product-schema";
import { and, eq, inArray } from "drizzle-orm";
import { isChatActionsKilled, resolveActionCatalog } from "../actions/catalog";
import { executeAction } from "../actions/execute";
import type { CapabilityQuote, CapabilityTurnState } from "../actions/types";
import {
  isImageGenerationActionSpec,
  MANAGED_CAPABILITY_ACTIONS_BY_ID,
} from "../capabilities/catalog";
import { evaluateManagedCapabilityApproval } from "../capabilities/execute";
import { evaluateImageGenerationApproval } from "../capabilities/image-generation";
import { resolveManagedCapabilities } from "../capabilities/resolve";
import {
  type ActionGatewayServiceDependencies,
  type ActionPrincipal,
  type ActionServiceRequest,
  type ActionServiceRunRef,
  executeActionGatewayService,
  executeActionHostGatewayService,
} from "./action-gateway";

const defaultDependencies: ActionGatewayServiceDependencies = {
  actionsKilled: isChatActionsKilled,
  loadContext: loadCodexActionContext,
  resolveCatalog: ({ actorId, workspaceId }) =>
    resolveActionCatalog(
      { userWorkosId: actorId, workspaceId },
      { resolveManagedCapabilities: resolveManagedCapabilities },
    ),
  executeAction: ({ actorId, conversationId, ...input }) =>
    executeAction({ ...input, userWorkosId: actorId, chatSessionId: conversationId }),
  getCapabilityTurnState: getCodexActionCapabilityTurnState,
  recordSourceDiscovery: ({ run, sourceId }) =>
    recordActionSourceDiscovery({ turn: actionTurnRef(run), sourceId }),
  claimInvocation: ({ run, ...input }) =>
    claimActionInvocation({ turn: actionTurnRef(run), ...input }),
  evaluateApproval: evaluateActionApproval,
  now: () => new Date(),
};

export function executeActionGateway(input: {
  request: ActionGatewayRequest;
  signal: AbortSignal;
  dependencies?: Partial<ActionGatewayServiceDependencies>;
}): Promise<ActionGatewayResponse> {
  return executeActionGatewayService({
    request: actionServiceRequest(input.request),
    signal: input.signal,
    dependencies: { ...defaultDependencies, ...input.dependencies },
  });
}

export function executeActionHostGateway(input: {
  request: ActionHostGatewayRequest;
  signal: AbortSignal;
  dependencies?: Partial<ActionGatewayServiceDependencies>;
}): Promise<ActionGatewayResponse> {
  return executeActionHostGatewayService({
    request: actionServiceRequest(input.request),
    signal: input.signal,
    dependencies: { ...defaultDependencies, ...input.dependencies },
  });
}

async function evaluateActionApproval(input: {
  request: Extract<ActionServiceRequest, { operation: "approval" }>;
  context: ActionPrincipal;
  turnState: CapabilityTurnState;
  signal: AbortSignal;
}) {
  const spec = MANAGED_CAPABILITY_ACTIONS_BY_ID.get(input.request.action);
  if (!spec) return false;
  if (isImageGenerationActionSpec(spec)) {
    return evaluateImageGenerationApproval({
      spec,
      params: input.request.params,
      toolCallId: input.request.invocationId,
      workspaceId: input.context.workspaceId,
      userWorkosId: input.context.actorId,
      chatSessionId: input.context.conversationId,
      turnState: input.turnState,
    });
  }
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

function getCodexActionCapabilityTurnState(
  request: ActionServiceRequest,
  context: ActionPrincipal,
): CapabilityTurnState {
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
        claimActionAsyncRun({ turn, invocationId: toolCallId, maxRuns }),
      releaseAsyncRun: ({ toolCallId }) =>
        releaseActionAsyncRun({ turn, invocationId: toolCallId }),
    },
  };
}

async function loadCodexActionContext(
  request: ActionServiceRequest,
): Promise<ActionPrincipal | null> {
  const [row] = await getDb()
    .select({
      userWorkosId: codexChatSessions.userWorkosId,
      workspaceId: codexChatSessions.workspaceId,
      chatSessionId: codexChatSessions.chatSessionId,
      userTimezone: users.timezone,
      engine: codexChatSessions.engine,
      assistantMessageId: codexChatTurns.assistantMessageId,
    })
    .from(codexChatSessions)
    .innerJoin(
      codexChatTurns,
      and(
        eq(codexChatTurns.id, request.runId),
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
          ...ACTION_HOST_TOOL_CONTRACT_VERSIONS,
          CHAT_HOST_TOOL_CONTRACT_VERSION,
        ]),
        eq(codexChatTurns.status, "running"),
      ),
    )
    .limit(1);

  if (!row?.workspaceId) return null;
  return {
    actorId: row.userWorkosId,
    workspaceId: row.workspaceId,
    conversationId: row.chatSessionId,
    userTimezone: row.userTimezone,
    engine: row.engine,
    assistantMessageId: row.assistantMessageId,
    policy: row.engine === "opencompany" ? "foregroundInteractive" : "cloudReadOnly",
  };
}

function actionTurnRef(run: ActionServiceRunRef) {
  return {
    sessionId: run.sessionId,
    turnId: run.runId,
    userWorkosId: run.actorId,
    workspaceId: run.workspaceId,
    policy: run.policy,
  };
}

function actionServiceRequest(
  request: ActionGatewayRequest,
): Extract<ActionServiceRequest, { operation: "list" | "execute" }>;
function actionServiceRequest(request: ActionHostGatewayRequest): ActionServiceRequest;
function actionServiceRequest(request: ActionHostGatewayRequest): ActionServiceRequest {
  const { turnId, ...input } = request;
  return { ...input, runId: turnId } as ActionServiceRequest;
}
