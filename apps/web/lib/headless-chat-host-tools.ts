import {
  GOAT_CHAT_HOST_TOOL_CONTRACT_VERSION,
  type GoatChatHostToolGatewayRequest,
  type GoatChatHostToolGatewayResponse,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  goatCodexChatSessions,
  goatCodexChatTurns,
  goatUsers,
  goatWorkspaceMembers,
  goatWorkspaces,
} from "@opencompany/db/goat-schema";
import { DEFAULT_GOAT_BRAIN_SLUG, listAccessibleGoatBrains } from "@opencompany/db/goat-workspaces";
import {
  executeGoatChatHostToolService,
  type GoatChatHostContext,
  type GoatChatHostToolCommand,
  type GoatChatHostToolServiceDependencies,
} from "@opencompany/goat-agent/application/host-tools";
import {
  browserProfilesAvailable,
  createAgentSession,
  endAgentSession,
  listConnectedBrowserProfilesForUser,
  resolveActiveAgentSession,
} from "@opencompany/goat-agent/browser-profiles/index";
import {
  activateAndListGoatChatSessionSkills,
  listGoatSkillCatalog,
  resolveGoatSkillMentions,
} from "@opencompany/goat-agent/skills";
import { runWikiToolForUser } from "@opencompany/goat-agent/wiki-tool";
import { listGoatWorkflowCatalog } from "@opencompany/goat-agent/workflows";
import { createLogger } from "@opencompany/observability";
import { and, eq } from "drizzle-orm";
import {
  createGoatTaskScheduleForUser,
  deleteGoatTaskScheduleForUser,
  listGoatTaskSchedulesForUser,
  updateGoatTaskScheduleForUser,
} from "@/lib/task-schedules";
import { createGoatTaskForUser } from "@/lib/tasks";
import { createGoatTaskFromWorkflow } from "@/lib/workflow-tasks";

const logger = createLogger({ service: "opencompany-goat", runtime: "headless-chat-host-tools" });

const defaultDependencies: GoatChatHostToolServiceDependencies = {
  loadContext: loadHostContext,
  listBrains: ({ actorId, workspaceId }) =>
    listAccessibleGoatBrains({ userWorkosId: actorId, workspaceId }),
  defaultBrainSlug: DEFAULT_GOAT_BRAIN_SLUG,
  browserProfilesAvailable,
  createAgentSession: ({ actorId, conversationId, messageId, ...input }) =>
    createAgentSession({
      ...input,
      userWorkosId: actorId,
      chatSessionId: conversationId,
      userMessageId: messageId,
    }),
  endAgentSession: ({ actorId, ...input }) => endAgentSession({ userWorkosId: actorId, ...input }),
  listBrowserProfiles: listConnectedBrowserProfilesForUser,
  resolveActiveAgentSession: ({ actorId, conversationId }) =>
    resolveActiveAgentSession({ userWorkosId: actorId, chatSessionId: conversationId }),
  resolveSkillMentions: resolveGoatSkillMentions,
  listSkillCatalog: listGoatSkillCatalog,
  activateAndListSkills: ({ conversationId, messageId, workspaceId, skills }) =>
    activateAndListGoatChatSessionSkills({
      chatSessionId: conversationId,
      activatedMessageId: messageId,
      workspaceRef: workspaceId,
      skills,
    }),
  createTask: ({ actorId, ...input }) => createGoatTaskForUser({ userWorkosId: actorId, ...input }),
  listSchedules: listGoatTaskSchedulesForUser,
  createSchedule: ({ actorId, ...input }) =>
    createGoatTaskScheduleForUser({ userWorkosId: actorId, ...input }),
  updateSchedule: (actorId, scheduleId, input) =>
    updateGoatTaskScheduleForUser(actorId, scheduleId, input),
  deleteSchedule: deleteGoatTaskScheduleForUser,
  createWorkflowTask: ({ actorId, ...input }) =>
    createGoatTaskFromWorkflow({ userWorkosId: actorId, ...input }),
  listWorkflowCatalog: listGoatWorkflowCatalog,
  executeBrowserTool: async ({ context, name, args, activeSession, signal }) => {
    const { createChatBrowserToolSession } = await import("@/lib/sandbox/browser-tools");
    return createChatBrowserToolSession({
      chatSessionId: context.conversationId,
      userWorkosId: context.actorId,
      signal,
      activeBrowserProfileAgentSession: activeSession,
      endBrowserProfileAgentSession: (session) =>
        endAgentSession({
          userWorkosId: context.actorId,
          profileId: session.profile.id,
          sessionId: session.sessionId,
        }),
    }).execute({ name, args });
  },
  runWikiTool: ({ workspaceId, actorId, toolInput }) =>
    runWikiToolForUser({ workspaceId, userWorkosId: actorId, toolInput: toolInput as never }),
  onRejected: (command) => {
    logger.warn("Headless Chat host tool rejected", {
      event: "opencompany.headless_chat_host_tool_rejected",
      operation: command.operation,
      session_id: command.sessionId,
      turn_id: command.runId,
    });
  },
  onCompleted: (command, durationMs) => {
    logger.info("Headless Chat host tool completed", {
      event: "opencompany.headless_chat_host_tool_completed",
      operation: command.operation,
      session_id: command.sessionId,
      turn_id: command.runId,
      duration_ms: durationMs,
    });
  },
  onFailed: (command, durationMs, error) => {
    logger.warn("Headless Chat host tool failed", {
      event: "opencompany.headless_chat_host_tool_failed",
      operation: command.operation,
      session_id: command.sessionId,
      turn_id: command.runId,
      duration_ms: durationMs,
      error: error instanceof Error ? error.name : "unknown",
    });
  },
};

export function executeHeadlessChatHostToolGateway(input: {
  request: GoatChatHostToolGatewayRequest;
  signal?: AbortSignal;
  dependencies?: Partial<GoatChatHostToolServiceDependencies>;
}): Promise<GoatChatHostToolGatewayResponse> {
  return executeGoatChatHostToolService({
    command: hostToolCommand(input.request),
    ...(input.signal ? { signal: input.signal } : {}),
    dependencies: { ...defaultDependencies, ...input.dependencies },
  });
}

async function loadHostContext(
  command: GoatChatHostToolCommand,
): Promise<GoatChatHostContext | null> {
  // Cleanup runs after the projector has atomically made the durable turn terminal.
  // Keep every model-visible operation fenced to `running`; the one cleanup operation
  // may resolve the same host-derived identity after settlement so an authenticated
  // browser profile cannot leak when a turn completes, fails, or is canceled.
  const runningTurn =
    command.operation === "browser_end_profile"
      ? undefined
      : eq(goatCodexChatTurns.status, "running");
  const [row] = await getDb()
    .select({
      userWorkosId: goatCodexChatSessions.userWorkosId,
      workspaceId: goatCodexChatSessions.workspaceId,
      chatSessionId: goatCodexChatSessions.chatSessionId,
      brainRef: goatCodexChatSessions.brainRef,
      userMessageId: goatCodexChatTurns.userMessageId,
      email: goatUsers.email,
      firstName: goatUsers.firstName,
      lastName: goatUsers.lastName,
      timezone: goatUsers.timezone,
      taskSpawningEnabled: goatUsers.taskSpawningEnabled,
      wikiEnabled: goatUsers.wikiEnabled,
      workspaceName: goatWorkspaces.name,
      workspaceRole: goatWorkspaceMembers.role,
    })
    .from(goatCodexChatSessions)
    .innerJoin(
      goatCodexChatTurns,
      and(
        eq(goatCodexChatTurns.id, command.runId),
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
    .innerJoin(goatWorkspaces, eq(goatWorkspaces.id, goatCodexChatSessions.workspaceId))
    .where(
      and(
        eq(goatCodexChatSessions.id, command.sessionId),
        eq(goatCodexChatSessions.engine, "opencompany"),
        eq(goatCodexChatSessions.hostToolContractVersion, GOAT_CHAT_HOST_TOOL_CONTRACT_VERSION),
        runningTurn,
      ),
    )
    .limit(1);
  if (!row?.workspaceId) return null;
  return {
    actorId: row.userWorkosId,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    conversationId: row.chatSessionId,
    messageId: row.userMessageId,
    brainRef: row.brainRef,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    timezone: row.timezone,
    taskToolsEnabled: row.taskSpawningEnabled && row.workspaceRole === "admin",
    wikiEnabled: row.wikiEnabled,
  };
}

function hostToolCommand(request: GoatChatHostToolGatewayRequest): GoatChatHostToolCommand {
  const { turnId, ...input } = request;
  return { ...input, runId: turnId };
}
