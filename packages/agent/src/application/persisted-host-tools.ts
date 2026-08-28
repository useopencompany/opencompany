import { createHash } from "node:crypto";
import {
  CHAT_HOST_TOOL_CONTRACT_VERSIONS,
  type ChatHostToolGatewayRequest,
  type ChatHostToolGatewayResponse,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import type { HarnessSpec } from "@opencompany/db/product-schema";
import {
  codexChatSessions,
  codexChatTurns,
  users,
  workspaceMembers,
  workspaces,
} from "@opencompany/db/product-schema";
import { DEFAULT_BRAIN_SLUG, listAccessibleBrains } from "@opencompany/db/workspaces";
import { createLogger } from "@opencompany/observability";
import { and, eq, inArray } from "drizzle-orm";
import {
  browserProfilesAvailable,
  createAgentSession,
  endAgentSession,
  listConnectedBrowserProfilesForUser,
  resolveActiveAgentSession,
} from "../browser-profiles/index";
import { createChatBrowserToolSession } from "../browser-tools-runtime";
import {
  activateAndListChatSessionSkills,
  createWorkspaceSkillForActor,
  listSkillCatalog,
  readChatSkillFile,
  resolveSkillMentions,
} from "../skills";
import {
  createTaskScheduleForUser,
  deleteTaskScheduleForUser,
  listTaskSchedulesForUser,
  updateTaskScheduleForUser,
} from "../task-schedules";
import { createTaskFromWorkflow } from "../workflow-tasks";
import { listWorkflowCatalog } from "../workflows";
import {
  type ChatHostContext,
  type ChatHostToolCommand,
  type ChatHostToolServiceDependencies,
  executeChatHostToolService,
} from "./host-tools";
import { createTaskForActor } from "./task-creation";

const logger = createLogger({ service: "opencompany-goat", runtime: "headless-chat-host-tools" });

export type PersistedHostRuntime = {
  wakeTaskWorker: () => Promise<unknown> | unknown;
  defer: (work: Promise<unknown>) => void;
  planHarness: (input: { actorId: string; prompt: string }) => Promise<HarnessSpec>;
  /**
   * Executes a `wiki` tool command through the API-owned boundary. The runner
   * injects an HTTP client that reaches apps/api; there is no direct-DB path.
   */
  executeWikiCommand?: (input: {
    workspaceId: string;
    actorId: string;
    toolInput: Record<string, unknown>;
    idempotencyKey: string;
  }) => Promise<unknown>;
};

export function executePersistedChatHostTool(input: {
  request: ChatHostToolGatewayRequest;
  runtime: PersistedHostRuntime;
  signal?: AbortSignal;
  dependencies?: Partial<ChatHostToolServiceDependencies>;
}): Promise<ChatHostToolGatewayResponse> {
  const taskDependencies = {
    wakeTaskWorker: input.runtime.wakeTaskWorker,
    defer: input.runtime.defer,
  };
  const dependencies: ChatHostToolServiceDependencies = {
    loadContext: loadHostContext,
    listBrains: ({ actorId, workspaceId }) =>
      listAccessibleBrains({ userWorkosId: actorId, workspaceId }),
    defaultBrainSlug: DEFAULT_BRAIN_SLUG,
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
    resolveSkillMentions: resolveSkillMentions,
    listSkillCatalog: listSkillCatalog,
    activateAndListSkills: ({ conversationId, messageId, workspaceId, skills }) =>
      activateAndListChatSessionSkills({
        chatSessionId: conversationId,
        activatedMessageId: messageId,
        workspaceId,
        skills,
      }),
    readSkillFile: ({ conversationId, ...skillFile }) =>
      readChatSkillFile({ chatSessionId: conversationId, ...skillFile }),
    createWorkspaceSkill: createWorkspaceSkillForActor,
    createTask: (task) =>
      createTaskForActor(
        {
          ...task,
          source: "agent",
          idempotencyKey: taskSpawnIdempotencyKey(input.request.turnId, input.request.toolCallId),
        },
        taskDependencies,
      ),
    listSchedules: listTaskSchedulesForUser,
    createSchedule: ({ actorId, workspaceId, ...schedule }) =>
      createTaskScheduleForUser(
        { ...schedule, userWorkosId: actorId, workspaceId },
        { planHarness: input.runtime.planHarness },
      ),
    updateSchedule: (actorId, scheduleId, schedule) =>
      updateTaskScheduleForUser(actorId, scheduleId, schedule, {
        planHarness: input.runtime.planHarness,
      }),
    deleteSchedule: deleteTaskScheduleForUser,
    createWorkflowTask: ({ actorId, ...workflow }) =>
      createTaskFromWorkflow(
        { ...workflow, userWorkosId: actorId },
        {
          createTask: (task) =>
            createTaskForActor(
              {
                ...task,
                source: "workflow",
                idempotencyKey: `workflow:${input.request.turnId}`,
              },
              taskDependencies,
            ),
        },
      ),
    listWorkflowCatalog: listWorkflowCatalog,
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
    runWikiTool: ({ workspaceId, actorId, toolInput, idempotencyKey }) => {
      if (!input.runtime.executeWikiCommand) {
        throw new Error("The wiki command client is not configured for this runtime.");
      }
      return input.runtime.executeWikiCommand({ workspaceId, actorId, toolInput, idempotencyKey });
    },
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
  return executeChatHostToolService({
    command: hostToolCommand(input.request),
    ...(input.signal ? { signal: input.signal } : {}),
    dependencies,
  });
}

export function taskSpawnIdempotencyKey(turnId: string, toolCallId?: string) {
  if (!toolCallId) return `agent:${turnId}`;
  const invocationHash = createHash("sha256").update(toolCallId).digest("hex");
  return `agent:${turnId}:tool:${invocationHash}`;
}

async function loadHostContext(command: ChatHostToolCommand): Promise<ChatHostContext | null> {
  // Cleanup is deliberately allowed after terminal projection; every model-visible
  // operation remains fenced to a running turn and the same persisted principal.
  const runningTurn =
    command.operation === "browser_end_profile" ? undefined : eq(codexChatTurns.status, "running");
  const [row] = await getDb()
    .select({
      userWorkosId: codexChatSessions.userWorkosId,
      workspaceId: codexChatSessions.workspaceId,
      chatSessionId: codexChatSessions.chatSessionId,
      brainRef: codexChatSessions.brainRef,
      userMessageId: codexChatTurns.userMessageId,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      timezone: users.timezone,
      taskSpawningEnabled: users.taskSpawningEnabled,
      wikiEnabled: users.wikiEnabled,
      workspaceName: workspaces.name,
      workspaceRole: workspaceMembers.role,
    })
    .from(codexChatSessions)
    .innerJoin(
      codexChatTurns,
      and(
        eq(codexChatTurns.id, command.runId),
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
    .innerJoin(workspaces, eq(workspaces.id, codexChatSessions.workspaceId))
    .where(
      and(
        eq(codexChatSessions.id, command.sessionId),
        eq(codexChatSessions.engine, "opencompany"),
        inArray(codexChatSessions.hostToolContractVersion, [...CHAT_HOST_TOOL_CONTRACT_VERSIONS]),
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
    skillToolsEnabled: row.workspaceRole === "admin",
    wikiEnabled: row.wikiEnabled,
  };
}

function hostToolCommand(request: ChatHostToolGatewayRequest): ChatHostToolCommand {
  const { turnId, toolCallId, ...command } = request;
  return { ...command, runId: turnId, ...(toolCallId ? { toolCallId } : {}) };
}
