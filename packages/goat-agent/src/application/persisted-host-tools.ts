import {
  GOAT_CHAT_HOST_TOOL_CONTRACT_VERSION,
  type GoatChatHostToolGatewayRequest,
  type GoatChatHostToolGatewayResponse,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import type { GoatHarnessSpec } from "@opencompany/db/goat-schema";
import {
  goatCodexChatSessions,
  goatCodexChatTurns,
  goatUsers,
  goatWorkspaceMembers,
  goatWorkspaces,
} from "@opencompany/db/goat-schema";
import { DEFAULT_GOAT_BRAIN_SLUG, listAccessibleGoatBrains } from "@opencompany/db/goat-workspaces";
import { createLogger } from "@opencompany/observability";
import { and, eq } from "drizzle-orm";
import {
  browserProfilesAvailable,
  createAgentSession,
  endAgentSession,
  listConnectedBrowserProfilesForUser,
  resolveActiveAgentSession,
} from "../browser-profiles/index";
import { createChatBrowserToolSession } from "../browser-tools-runtime";
import {
  activateAndListGoatChatSessionSkills,
  listGoatSkillCatalog,
  resolveGoatSkillMentions,
} from "../skills";
import {
  createGoatTaskScheduleForUser,
  deleteGoatTaskScheduleForUser,
  listGoatTaskSchedulesForUser,
  updateGoatTaskScheduleForUser,
} from "../task-schedules";
import { runWikiToolForUser } from "../wiki-tool";
import { createGoatTaskFromWorkflow } from "../workflow-tasks";
import { listGoatWorkflowCatalog } from "../workflows";
import {
  executeGoatChatHostToolService,
  type GoatChatHostContext,
  type GoatChatHostToolCommand,
  type GoatChatHostToolServiceDependencies,
} from "./host-tools";
import { createGoatTaskForActor } from "./task-creation";

const logger = createLogger({ service: "opencompany-goat", runtime: "headless-chat-host-tools" });

export type PersistedGoatHostRuntime = {
  wakeTaskWorker: () => Promise<unknown> | unknown;
  defer: (work: Promise<unknown>) => void;
  planHarness: (input: { actorId: string; prompt: string }) => Promise<GoatHarnessSpec>;
};

export function executePersistedGoatChatHostTool(input: {
  request: GoatChatHostToolGatewayRequest;
  runtime: PersistedGoatHostRuntime;
  signal?: AbortSignal;
  dependencies?: Partial<GoatChatHostToolServiceDependencies>;
}): Promise<GoatChatHostToolGatewayResponse> {
  const taskDependencies = {
    wakeTaskWorker: input.runtime.wakeTaskWorker,
    defer: input.runtime.defer,
  };
  const dependencies: GoatChatHostToolServiceDependencies = {
    loadContext: loadHostContext,
    listBrains: ({ actorId, workspaceId }) =>
      listAccessibleGoatBrains({ userWorkosId: actorId, workspaceId }),
    defaultBrainSlug: DEFAULT_GOAT_BRAIN_SLUG,
    browserProfilesAvailable,
    createAgentSession: ({ actorId, conversationId, messageId, ...session }) =>
      createAgentSession({
        ...session,
        userWorkosId: actorId,
        chatSessionId: conversationId,
        userMessageId: messageId,
      }),
    endAgentSession: ({ actorId, ...session }) =>
      endAgentSession({ userWorkosId: actorId, ...session }),
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
    createTask: (task) => createGoatTaskForActor(task, taskDependencies),
    listSchedules: listGoatTaskSchedulesForUser,
    createSchedule: ({ actorId, ...schedule }) =>
      createGoatTaskScheduleForUser(
        { ...schedule, userWorkosId: actorId },
        { planHarness: input.runtime.planHarness },
      ),
    updateSchedule: (actorId, scheduleId, schedule) =>
      updateGoatTaskScheduleForUser(actorId, scheduleId, schedule, {
        planHarness: input.runtime.planHarness,
      }),
    deleteSchedule: deleteGoatTaskScheduleForUser,
    createWorkflowTask: ({ actorId, ...workflow }) =>
      createGoatTaskFromWorkflow(
        { ...workflow, userWorkosId: actorId },
        {
          createTask: (task) => createGoatTaskForActor(task, taskDependencies),
        },
      ),
    listWorkflowCatalog: listGoatWorkflowCatalog,
    executeBrowserTool: async ({ context, name, args, activeSession, signal }) =>
      createChatBrowserToolSession({
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
      }).execute({ name, args }),
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
    ...input.dependencies,
  };
  return executeGoatChatHostToolService({
    command: hostToolCommand(input.request),
    ...(input.signal ? { signal: input.signal } : {}),
    dependencies,
  });
}

async function loadHostContext(
  command: GoatChatHostToolCommand,
): Promise<GoatChatHostContext | null> {
  // Cleanup is deliberately allowed after terminal projection; every model-visible
  // operation remains fenced to a running turn and the same persisted principal.
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
  const { turnId, ...command } = request;
  return { ...command, runId: turnId };
}
