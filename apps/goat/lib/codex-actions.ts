import {
  GOAT_CODEX_ACTION_HOST_TOOL_CONTRACT_VERSIONS,
  type GoatCodexActionGatewayRequest,
  type GoatCodexActionGatewayResponse,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  goatCodexChatSessions,
  goatCodexChatTurns,
  goatUsers,
  goatWorkspaceMembers,
} from "@opencompany/db/goat-schema";
import { and, eq, inArray } from "drizzle-orm";
import { isGoatChatActionsKilled, resolveGoatActionCatalog } from "@/lib/actions/catalog";
import { executeGoatAction } from "@/lib/actions/execute";
import type { GoatCapabilityTurnState, GoatResolvedActionCatalog } from "@/lib/actions/types";

type GoatCodexActionContext = {
  userWorkosId: string;
  workspaceId: string;
  chatSessionId: string;
  userTimezone: string;
};

type GoatCodexActionDependencies = {
  loadContext: (request: GoatCodexActionGatewayRequest) => Promise<GoatCodexActionContext | null>;
  resolveCatalog: typeof resolveGoatActionCatalog;
  executeAction: typeof executeGoatAction;
  getCapabilityTurnState: (request: GoatCodexActionGatewayRequest) => GoatCapabilityTurnState;
  now: () => Date;
};

const defaultDependencies: GoatCodexActionDependencies = {
  loadContext: loadGoatCodexActionContext,
  resolveCatalog: resolveGoatActionCatalog,
  executeAction: executeGoatAction,
  getCapabilityTurnState: getGoatCodexActionCapabilityTurnState,
  now: () => new Date(),
};

const GOAT_CODEX_ACTION_CAPABILITY_STATE_TTL_MS = 6 * 60 * 60 * 1000;
const goatCodexActionCapabilityTurnStates = new Map<
  string,
  { expiresAt: number; state: GoatCapabilityTurnState }
>();

export async function executeGoatCodexActionGateway(input: {
  request: GoatCodexActionGatewayRequest;
  signal: AbortSignal;
  dependencies?: Partial<GoatCodexActionDependencies>;
}): Promise<GoatCodexActionGatewayResponse> {
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  if (isGoatChatActionsKilled()) {
    return gatewayError("disabled", "Actions are temporarily disabled.");
  }

  const context = await dependencies.loadContext(input.request);
  if (!context) {
    return gatewayError("not_permitted", "This Codex turn can no longer access actions.");
  }

  let catalog: GoatResolvedActionCatalog;
  try {
    catalog = readOnlyCatalog(
      await dependencies.resolveCatalog({
        userWorkosId: context.userWorkosId,
        workspaceId: context.workspaceId,
      }),
    );
  } catch {
    return gatewayError("internal", "The action catalog could not be loaded.");
  }

  if (input.request.operation === "list") {
    const sourceId = input.request.source;
    if (!sourceId) {
      return {
        ok: true,
        sources: catalog.providers.map(({ id, kind, label, description }) => ({
          id,
          kind: kind ?? "integration",
          label,
          description,
        })),
      };
    }

    const source = catalog.providers.find((entry) => entry.id === sourceId);
    if (!source) {
      return gatewayError(
        "invalid_params",
        `"${sourceId}" is not an available source. Call list_actions without a source for the current catalog.`,
      );
    }
    return {
      ok: true,
      source: {
        id: source.id,
        kind: source.kind ?? "integration",
        label: source.label,
        description: source.description,
      },
      actions: catalog.actions
        .filter((action) => action.provider === source.id)
        .map((action) => ({
          id: action.id,
          source: action.provider,
          description: action.description,
          params: action.params,
        })),
    };
  }

  const actionId = input.request.action;
  const action = catalog.actions.find((entry) => entry.id === actionId);
  if (!action) {
    return {
      ok: false,
      action: actionId,
      error: {
        code: "invalid_params",
        message: `"${actionId}" is not an available read action. Call list_actions with the relevant source id for the current catalog.`,
      },
    };
  }

  return dependencies.executeAction({
    catalog,
    actionId,
    params: input.request.params,
    userWorkosId: context.userWorkosId,
    workspaceId: context.workspaceId,
    chatSessionId: context.chatSessionId,
    toolCallId: input.request.toolCallId,
    capabilityTurnState: dependencies.getCapabilityTurnState(input.request),
    signal: input.signal,
    currentDate: dependencies.now(),
    userTimezone: context.userTimezone,
  });
}

function readOnlyCatalog(catalog: GoatResolvedActionCatalog): GoatResolvedActionCatalog {
  const sourceIds = new Set(catalog.providers.map((source) => source.id));
  const actions = catalog.actions.filter(
    (action) =>
      action.capability === "read" &&
      action.permissionMode === "on" &&
      sourceIds.has(action.provider),
  );
  const activeSourceIds = new Set(actions.map((action) => action.provider));
  return {
    providers: catalog.providers
      .filter((source) => activeSourceIds.has(source.id))
      .map((source) => ({ ...source, kind: source.kind ?? "integration" })),
    actions,
  };
}

function getGoatCodexActionCapabilityTurnState(
  request: GoatCodexActionGatewayRequest,
): GoatCapabilityTurnState {
  const now = Date.now();
  for (const [key, entry] of goatCodexActionCapabilityTurnStates) {
    if (entry.expiresAt <= now) goatCodexActionCapabilityTurnStates.delete(key);
  }

  const key = `${request.codexChatSessionId}:${request.codexChatTurnId}`;
  const existing = goatCodexActionCapabilityTurnStates.get(key);
  if (existing) {
    existing.expiresAt = now + GOAT_CODEX_ACTION_CAPABILITY_STATE_TTL_MS;
    return existing.state;
  }

  const state: GoatCapabilityTurnState = {
    quotedTotalUsdMicros: 0,
    admittedToolCallIds: [],
    quotesByToolCallId: new Map(),
    asyncRunsStarted: 0,
  };
  goatCodexActionCapabilityTurnStates.set(key, {
    expiresAt: now + GOAT_CODEX_ACTION_CAPABILITY_STATE_TTL_MS,
    state,
  });
  return state;
}

async function loadGoatCodexActionContext(
  request: GoatCodexActionGatewayRequest,
): Promise<GoatCodexActionContext | null> {
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
        eq(goatCodexChatTurns.id, request.codexChatTurnId),
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
        eq(goatCodexChatSessions.id, request.codexChatSessionId),
        inArray(goatCodexChatSessions.hostToolContractVersion, [
          ...GOAT_CODEX_ACTION_HOST_TOOL_CONTRACT_VERSIONS,
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

function gatewayError(code: string, message: string): GoatCodexActionGatewayResponse {
  return { ok: false, error: { code, message } };
}
