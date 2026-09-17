import {
  CHAT_HOST_TOOL_CONTRACT_VERSIONS,
  type ChatHostToolGatewayRequest,
  type ChatHostToolGatewayResponse,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import type { HarnessSpec } from "@opencompany/db/product-schema";
import {
  chatSessions,
  codexChatSessions,
  codexChatTurns,
  tasks,
  users,
  workflows,
  workspaceMembers,
  workspaces,
} from "@opencompany/db/product-schema";
import { createLogger } from "@opencompany/observability";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  browserProfilesAvailable,
  createAgentSession,
  endAgentSession,
  listConnectedBrowserProfilesForUser,
  resolveActiveAgentSession,
} from "../browser-profiles/index";
import { createChatBrowserToolSession } from "../browser-tools-runtime";
import { postWorkflowSlackMessage } from "../integrations/slack-channel";
import {
  activateAndListChatSessionSkills,
  createWorkspaceSkillForActor,
  listSkillCatalog,
  manageWorkspaceSkillsForActor,
  readChatSkillFile,
  resolveSkillMentions,
  updateWorkspaceSkillForActor,
} from "../skills";
import { refineWorkflowTaskTitle } from "../workflow-task-title";
import { createTaskFromWorkflow } from "../workflow-tasks";
import { listWorkflowCatalog } from "../workflows";
import {
  type ChatHostContext,
  type ChatHostToolCommand,
  type ChatHostToolServiceDependencies,
  executeChatHostToolService,
} from "./host-tools";
import { createTaskForActor, updateTaskForActor } from "./task-creation";

const logger = createLogger({ service: "opencompany-goat", runtime: "headless-chat-host-tools" });

export type PersistedHostRuntime = {
  wakeTaskWorker: () => Promise<unknown> | unknown;
  defer: (work: Promise<unknown>) => void;
  gatewayApiKey: string;
  /**
   * Executes a `wiki` tool command through the API-owned boundary. The runner
   * injects an HTTP client that reaches apps/api; there is no direct-DB path.
   */
  executeWikiCommand?: (input: {
    workspaceId: string;
    actorId: string;
    toolInput: Record<string, unknown>;
    wikiId?: string;
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
    listSkillCatalog: (workspaceId, userId, skillAccess) =>
      listSkillCatalog(workspaceId, undefined, userId, skillAccess),
    activateAndListSkills: ({
      conversationId,
      messageId,
      workspaceId,
      skills,
      userId,
      skillAccess,
    }) =>
      activateAndListChatSessionSkills({
        chatSessionId: conversationId,
        activatedMessageId: messageId,
        workspaceId,
        userId,
        ...(skillAccess ? { skillAccess } : {}),
        skills,
      }),
    readSkillFile: ({ conversationId, ...skillFile }) =>
      readChatSkillFile({ chatSessionId: conversationId, ...skillFile }),
    createWorkspaceSkill: createWorkspaceSkillForActor,
    manageWorkspaceSkills: manageWorkspaceSkillsForActor,
    updateWorkspaceSkill: updateWorkspaceSkillForActor,
    createWorkflowTask: async ({ actorId, ...workflow }) => {
      const task = await createTaskFromWorkflow(
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
      );
      if (!task.sessionId) return task;

      const updated = await refineWorkflowTaskTitle(
        {
          taskId: task.id,
          conversationId: task.sessionId,
          workflowName: task.name,
          description: workflow.description,
          apiKey: input.runtime.gatewayApiKey,
          actorId,
        },
        {
          updateTaskName: (name) =>
            updateTaskForActor({
              actorId,
              workspaceId: workflow.workspaceId,
              taskId: task.id,
              name,
            }),
        },
      );
      return updated ? { ...task, name: updated.task.name } : task;
    },
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
    runWikiTool: ({ workspaceId, actorId, toolInput, wikiId, idempotencyKey }) => {
      if (!input.runtime.executeWikiCommand) {
        throw new Error("The wiki command client is not configured for this runtime.");
      }
      return input.runtime.executeWikiCommand({
        workspaceId,
        actorId,
        toolInput,
        ...(wikiId ? { wikiId } : {}),
        idempotencyKey,
      });
    },
    postSlackMessage: postWorkflowSlackMessage,
    writeArtifact: () => {
      throw new Error("Artifact publishing is not configured for this runtime.");
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

async function loadHostContext(command: ChatHostToolCommand): Promise<ChatHostContext | null> {
  // Cleanup is deliberately allowed after terminal projection; every model-visible
  // operation remains fenced to a running turn and the same persisted principal.
  const runningTurn =
    command.operation === "browser_end_profile" ? undefined : eq(codexChatTurns.status, "running");
  const [row] = await getDb()
    .select({
      conversationKind: chatSessions.kind,
      harness: codexChatSessions.harness,
      userWorkosId: codexChatSessions.userWorkosId,
      workspaceId: codexChatSessions.workspaceId,
      chatSessionId: codexChatSessions.chatSessionId,
      userMessageId: codexChatTurns.userMessageId,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      timezone: users.timezone,
      subagentsEnabled: users.subagentsEnabled,
      workspaceName: workspaces.name,
      workspaceRole: workspaceMembers.role,
      slackChannelEnabled: workflows.slackChannelEnabled,
      // A Task opened from a Slack direct message has no workflow to read the toggle from. Its
      // open thread subscription is the equivalent grant: the Task exists to answer that thread.
      // A workflow Task keeps reading the toggle, so retiring a workflow still withholds the tool
      // from a Task whose Slack thread is still open.
      slackThreadSubscribed: sql<boolean>`${tasks.workflowId} IS NULL AND EXISTS (
        SELECT 1 FROM goat.session_subscriptions subscription
        WHERE subscription.session_id = ${codexChatSessions.chatSessionId}
          AND subscription.source = 'slack_thread' AND subscription.status = 'waiting'
          AND subscription.expires_at > now())`,
    })
    .from(codexChatSessions)
    .innerJoin(chatSessions, eq(chatSessions.id, codexChatSessions.chatSessionId))
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
    // Only a workflow run can post to Slack, and only while its Channels section keeps Slack on.
    // Tasks store the workflow slug, so the creation-time fence keeps an old Task from inheriting
    // a later workflow that reused the same slug after archival.
    .leftJoin(tasks, eq(tasks.sessionId, codexChatSessions.chatSessionId))
    .leftJoin(
      workflows,
      and(
        eq(workflows.workspaceId, tasks.workspaceId),
        eq(workflows.slug, tasks.workflowId),
        isNull(workflows.archivedAt),
        lte(workflows.createdAt, tasks.createdAt),
      ),
    )
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
    taskConversation: row.conversationKind === "task",
    actorId: row.userWorkosId,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    conversationId: row.chatSessionId,
    messageId: row.userMessageId,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    timezone: row.timezone,
    slackChannelEnabled: row.slackChannelEnabled === true || row.slackThreadSubscribed === true,
    // The iMessage personal agent is a phone surface: no workflow, schedule or subagent tools
    // even for admins. Its runner does not wire those runners either; this is the server fence.
    automationToolsEnabled: row.workspaceRole === "admin" && row.harness !== "personal_agent",
    // Read-only and personal, so unlike the automation tools this needs no admin role.
    subagentsEnabled: row.subagentsEnabled && row.harness !== "personal_agent",
    skillToolsEnabled: true,
  };
}

function hostToolCommand(request: ChatHostToolGatewayRequest): ChatHostToolCommand {
  const { turnId, toolCallId, ...command } = request;
  return { ...command, runId: turnId, ...(toolCallId ? { toolCallId } : {}) };
}
