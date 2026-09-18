import { randomUUID } from "node:crypto";
import {
  ACTION_HOST_TOOL_CONTRACT_VERSIONS,
  type ActionGatewayRequest,
  type ActionGatewayResponse,
  type ActionHostGatewayRequest,
  CHAT_HOST_TOOL_CONTRACT_VERSIONS,
} from "@opencompany/agent-runtime";
import { captureProductServerEvent } from "@opencompany/analytics/product/server";
import {
  actionApprovalInputHash,
  claimActionAsyncRun,
  claimActionInvocation,
  finishAutomaticApprovalReview,
  getActionApproval,
  getActionCapabilityTurnState,
  recordActionSourceDiscovery,
  registerActionApproval,
  releaseActionAsyncRun,
  releaseActionCapabilityQuote,
  revokeAutomaticApproval,
  storeActionCapabilityQuote,
} from "@opencompany/db/action-governance";
import { getDb } from "@opencompany/db/client";
import {
  chatSessions,
  codexChatSessions,
  codexChatTurns,
  users,
  workspaceMembers,
} from "@opencompany/db/product-schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { isChatActionsKilled, resolveActionCatalog } from "../actions/catalog";
import { executeAction } from "../actions/execute";
import type { CapabilityQuote, CapabilityTurnState } from "../actions/types";
import { APPROVAL_REVIEW_MODEL, APPROVAL_REVIEW_POLICY, reviewAction } from "../approval-review";
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
  resolveCatalog: ({ actorId, workspaceId, conversationId }) =>
    resolveActionCatalog(
      {
        userWorkosId: actorId,
        workspaceId,
        ...(conversationId ? { chatSessionId: conversationId } : {}),
      },
      { resolveManagedCapabilities: resolveManagedCapabilities },
    ),
  executeAction: ({ actorId, conversationId, ...input }) =>
    executeAction({ ...input, userWorkosId: actorId, chatSessionId: conversationId }),
  getCapabilityTurnState: getCodexActionCapabilityTurnState,
  recordSourceDiscovery: ({ run, sourceId }) =>
    recordActionSourceDiscovery({ turn: actionTurnRef(run), sourceId }),
  claimInvocation: ({ run, ...input }) =>
    claimActionInvocation({ turn: actionTurnRef(run), ...input }),
  registerApproval: registerReviewedApproval,
  evaluateApproval: evaluateActionApproval,
  now: () => new Date(),
};

type ActionGatewayInput = {
  request: ActionGatewayRequest;
  signal: AbortSignal;
};

type ActionHostGatewayInput = {
  request: ActionHostGatewayRequest;
  signal: AbortSignal;
};

type ActionPrincipalGatewayInput = ActionHostGatewayInput & {
  principal: ActionPrincipal & { policy: "headless" };
};

export function createActionGateway(
  overrides: Partial<ActionGatewayServiceDependencies> = {},
): (input: ActionGatewayInput) => Promise<ActionGatewayResponse> {
  const dependencies = { ...defaultDependencies, ...overrides };
  return (input) =>
    executeActionGatewayService({
      request: actionServiceRequest(input.request),
      signal: input.signal,
      dependencies,
    });
}

export function createActionHostGateway(
  overrides: Partial<ActionGatewayServiceDependencies> = {},
): (input: ActionHostGatewayInput) => Promise<ActionGatewayResponse> {
  const dependencies = { ...defaultDependencies, ...overrides };
  return (input) =>
    executeActionHostGatewayService({
      request: actionServiceRequest(input.request),
      signal: input.signal,
      dependencies,
    });
}

export function createActionPrincipalGateway(
  overrides: Partial<ActionGatewayServiceDependencies> = {},
): (input: ActionPrincipalGatewayInput) => Promise<ActionGatewayResponse> {
  const dependencies = { ...defaultDependencies, ...overrides };
  return (input) =>
    executeActionHostGatewayService({
      request: actionServiceRequest(input.request),
      signal: input.signal,
      dependencies: {
        ...dependencies,
        loadContext: async () => input.principal,
      },
    });
}

export const executeActionGateway = createActionGateway();
export const executeActionHostGateway = createActionHostGateway();
export const executeActionPrincipalGateway = createActionPrincipalGateway();

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
    policy: context.policy ?? "foregroundInteractive",
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
      hostToolContractVersion: codexChatSessions.hostToolContractVersion,
      workspaceId: codexChatSessions.workspaceId,
      chatSessionId: codexChatSessions.chatSessionId,
      userTimezone: users.timezone,
      engine: codexChatSessions.engine,
      assistantMessageId: codexChatTurns.assistantMessageId,
      chatKind: chatSessions.kind,
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
    .innerJoin(chatSessions, eq(chatSessions.id, codexChatSessions.chatSessionId))
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
          ...CHAT_HOST_TOOL_CONTRACT_VERSIONS,
        ]),
        eq(codexChatTurns.status, "running"),
        isNull(codexChatTurns.interruptRequestedAt),
      ),
    )
    .limit(1);

  if (!row?.workspaceId) return null;
  return {
    actorId: row.userWorkosId,
    ...(row.hostToolContractVersion
      ? { hostToolContractVersion: row.hostToolContractVersion }
      : {}),
    workspaceId: row.workspaceId,
    conversationId: row.chatSessionId,
    userTimezone: row.userTimezone,
    engine: row.engine,
    assistantMessageId: row.assistantMessageId,
    policy: row.chatKind === "task" ? "headless" : "foregroundInteractive",
    durableTaskApprovals: row.chatKind === "task",
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
): Extract<ActionServiceRequest, { operation: "list" | "describe" | "execute" }>;
function actionServiceRequest(request: ActionHostGatewayRequest): ActionServiceRequest;
function actionServiceRequest(request: ActionHostGatewayRequest): ActionServiceRequest {
  const { turnId, ...input } = request;
  return { ...input, runId: turnId } as ActionServiceRequest;
}

export async function registerReviewedApproval(
  {
    run,
    action,
    signal,
    ...input
  }: Parameters<ActionGatewayServiceDependencies["registerApproval"]>[0],
  dependencies: {
    db: any;
    review: typeof reviewAction;
    capture: typeof captureProductServerEvent;
  } = { db: getDb(), review: reviewAction, capture: captureProductServerEvent },
) {
  const { db } = dependencies;
  const turn = actionTurnRef(run);
  const actionContext = action
    ? actionApprovalInputHash(
        {
          id: action.id,
          description: action.description,
          effects: action.effects,
          schema: action.params,
          integrationIds: action.permission?.integrationIds ?? [],
          provider: action.permission?.provider ?? null,
        },
        input.approvalContext,
      )
    : undefined;
  // Read intent from the authenticated turn, never from the action's model-supplied rationale.
  const [owner] = await db
    .select({ enabled: users.approveForMeEnabled, prompt: codexChatTurns.prompt })
    .from(codexChatTurns)
    .innerJoin(users, eq(users.workosUserId, codexChatTurns.userWorkosId))
    .where(
      and(
        eq(codexChatTurns.id, run.runId),
        eq(codexChatTurns.userWorkosId, run.actorId),
        eq(codexChatTurns.codexChatSessionId, run.sessionId),
        eq(codexChatTurns.status, "running"),
        isNull(codexChatTurns.interruptRequestedAt),
      ),
    )
    .limit(1);
  const token = owner?.enabled && action && input.decision !== "denied" ? randomUUID() : undefined;
  const record = await registerActionApproval({
    db,
    turn,
    ...input,
    ...(token ? { reviewToken: token } : {}),
  });
  if (!record) return null;
  if (
    record.status === "approved" &&
    record.automaticReview?.outcome === "auto_approved" &&
    (!owner?.enabled ||
      record.automaticReview.policy !== APPROVAL_REVIEW_POLICY ||
      record.automaticReview.actionContext !== actionContext)
  ) {
    await revokeAutomaticApproval({
      db,
      turn,
      invocationId: input.invocationId,
      reason: !owner?.enabled
        ? "preference_disabled"
        : record.automaticReview.policy !== APPROVAL_REVIEW_POLICY
          ? "policy_changed"
          : "action_changed",
    });
    return getActionApproval({ db, turn, invocationId: input.invocationId });
  }
  if (
    !token ||
    record.status !== "pending" ||
    record.automaticReview ||
    !record.reviewToken ||
    !action ||
    !owner
  )
    return record;
  // A parallel check must not present a request that a competing review can later release.
  // Resolve competing checks to manual approval; only the winning completion emits an event.
  const review =
    record.reviewToken !== token
      ? {
          outcome: "requires_approval" as const,
          reason: "unavailable" as const,
          model: APPROVAL_REVIEW_MODEL,
          policy: APPROVAL_REVIEW_POLICY,
          durationMs: 0,
        }
      : await dependencies.review({
          action,
          params: input.params,
          userRequest: owner.prompt,
          apiKey: process.env.VERCEL_AI_GATEWAY_API_KEY,
          ...(signal ? { signal } : {}),
        });
  if (signal?.aborted) return record;
  const resolved = await finishAutomaticApprovalReview({
    db,
    turn,
    invocationId: input.invocationId,
    reviewToken: record.reviewToken,
    inputHash: record.inputHash,
    review: { ...review, ...(actionContext ? { actionContext } : {}) },
  });
  if (resolved)
    await dependencies.capture("action_approval_reviewed", run.actorId, {
      workspace_id: run.workspaceId,
      run_id: run.runId,
      request_id: input.invocationId,
      action_id: action.id,
      surface: run.policy === "headless" ? "task" : "chat",
      outcome: review.outcome,
      reason: review.reason,
      model: review.model,
      policy_version: review.policy,
      duration_ms: review.durationMs,
    });
  return resolved ?? getActionApproval({ db, turn, invocationId: input.invocationId });
}
