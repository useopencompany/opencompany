import {
  AGENT_MODEL_CATALOG,
  GOAT_CHAT_HOST_TOOL_CONTRACT_VERSION,
  type GoatChatHostBootstrap,
  type GoatChatHostToolGatewayRequest,
  type GoatChatHostToolGatewayResponse,
} from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { isBrowserToolName } from "@opencompany/browser-tools";
import { getDb } from "@opencompany/db/client";
import type { GoatHarnessEngine } from "@opencompany/db/goat-schema";
import {
  goatCodexChatSessions,
  goatCodexChatTurns,
  goatUsers,
  goatWorkspaceMembers,
  goatWorkspaces,
} from "@opencompany/db/goat-schema";
import { DEFAULT_GOAT_BRAIN_SLUG, listAccessibleGoatBrains } from "@opencompany/db/goat-workspaces";
import type {
  DeleteTaskScheduleToolOutput,
  EditTaskScheduleToolOutput,
} from "@opencompany/goat-agent/chat-ui";
import { createLogger } from "@opencompany/observability";
import { and, eq } from "drizzle-orm";
import {
  browserProfilesAvailable,
  createAgentSession,
  endAgentSession,
  listConnectedBrowserProfilesForUser,
  resolveActiveAgentSession,
} from "@/lib/browser-profiles";
import {
  activateAndListGoatChatSessionSkills,
  listGoatSkillCatalog,
  resolveGoatSkillMentions,
} from "@/lib/skills";
import {
  createGoatTaskScheduleForUser,
  deleteGoatTaskScheduleForUser,
  listGoatTaskSchedulesForUser,
  updateGoatTaskScheduleForUser,
} from "@/lib/task-schedules";
import { createGoatTaskForUser } from "@/lib/tasks";
import { runWikiToolForUser } from "@/lib/wiki-tool";
import { createGoatTaskFromWorkflow } from "@/lib/workflow-tasks";
import { listGoatWorkflowCatalog } from "@/lib/workflows";

type HostContext = {
  userWorkosId: string;
  workspaceId: string;
  workspaceName: string;
  chatSessionId: string;
  userMessageId: string;
  brainRef: string | null;
  email: string;
  firstName: string | null;
  lastName: string | null;
  timezone: string;
  taskToolsEnabled: boolean;
  wikiEnabled: boolean;
};

type Dependencies = {
  loadContext: (request: GoatChatHostToolGatewayRequest) => Promise<HostContext | null>;
  browserProfilesAvailable: typeof browserProfilesAvailable;
  createAgentSession: typeof createAgentSession;
  endAgentSession: typeof endAgentSession;
  listBrowserProfiles: typeof listConnectedBrowserProfilesForUser;
  resolveActiveAgentSession: typeof resolveActiveAgentSession;
};

const defaultDependencies: Dependencies = {
  loadContext: loadHostContext,
  browserProfilesAvailable,
  createAgentSession,
  endAgentSession,
  listBrowserProfiles: listConnectedBrowserProfilesForUser,
  resolveActiveAgentSession,
};
const logger = createLogger({ service: "opencompany-goat", runtime: "headless-chat-host-tools" });

export async function executeHeadlessChatHostToolGateway(input: {
  request: GoatChatHostToolGatewayRequest;
  signal?: AbortSignal;
  dependencies?: Partial<Dependencies>;
}): Promise<GoatChatHostToolGatewayResponse> {
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  const context = await dependencies.loadContext(input.request);
  if (!context) {
    logger.warn("Headless Chat host tool rejected", {
      event: "opencompany.headless_chat_host_tool_rejected",
      operation: input.request.operation,
      session_id: input.request.sessionId,
      turn_id: input.request.turnId,
    });
    return failure("This Chat turn can no longer use host tools.");
  }
  const startedAt = Date.now();
  try {
    const response: GoatChatHostToolGatewayResponse = {
      ok: true,
      result: await executeOperation(
        context,
        input.request,
        input.signal ?? new AbortController().signal,
        dependencies,
      ),
    };
    logger.info("Headless Chat host tool completed", {
      event: "opencompany.headless_chat_host_tool_completed",
      operation: input.request.operation,
      session_id: input.request.sessionId,
      turn_id: input.request.turnId,
      duration_ms: Date.now() - startedAt,
    });
    return response;
  } catch (error) {
    logger.warn("Headless Chat host tool failed", {
      event: "opencompany.headless_chat_host_tool_failed",
      operation: input.request.operation,
      session_id: input.request.sessionId,
      turn_id: input.request.turnId,
      duration_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.name : "unknown",
    });
    return failure(error instanceof Error ? error.message : "The Chat host tool failed.");
  }
}

async function executeOperation(
  context: HostContext,
  request: GoatChatHostToolGatewayRequest,
  signal: AbortSignal,
  dependencies: Dependencies,
): Promise<unknown> {
  const toolInput = request.input ?? {};
  switch (request.operation) {
    case "bootstrap":
      return bootstrap(context, toolInput, dependencies);
    case "use_skill": {
      const skill = requiredString(toolInput.skill, "skill");
      const [resolved] = await resolveGoatSkillMentions({
        workspaceId: context.workspaceId,
        mentions: [{ id: skill }],
      });
      if (!resolved) throw new Error(`Skill "@skill/${skill}" is unavailable or incomplete.`);
      return { ok: true, skill: resolved };
    }
    case "start_task": {
      assertTaskTools(context);
      const model = requiredModel(toolInput.model);
      const name = optionalString(toolInput.name);
      const engine = optionalEngine(toolInput.engine);
      const created = await createGoatTaskForUser({
        userWorkosId: context.userWorkosId,
        workspaceId: context.workspaceId,
        brainRef: await activeBrainRef(context),
        prompt: requiredString(toolInput.prompt, "prompt"),
        model,
        ...(name ? { name } : {}),
        ...(engine ? { engine } : {}),
      });
      return taskResult(created);
    }
    case "schedule_task": {
      assertTaskTools(context);
      const created = await createGoatTaskScheduleForUser({
        userWorkosId: context.userWorkosId,
        name: requiredString(toolInput.name, "name"),
        sourceDescription:
          optionalString(toolInput.sourceDescription) ?? optionalString(toolInput.reason) ?? "",
        cron: requiredString(toolInput.cron, "cron"),
        timezone: optionalString(toolInput.timezone) ?? context.timezone,
        prompt: requiredString(toolInput.prompt, "prompt"),
      });
      return {
        scheduleId: created.id,
        scheduleName: created.name,
        cron: created.cron,
        timezone: created.timezone,
        nextRunAt: created.nextRunAt.toISOString(),
        prompt: created.prompt,
        status: "scheduled",
      };
    }
    case "edit_task_schedule": {
      assertTaskTools(context);
      const schedules = await listGoatTaskSchedulesForUser(context.userWorkosId);
      const target = resolveScheduleTarget(schedules, toolInput);
      if (!target.ok) return target;
      const cron = optionalString(toolInput.cron) ?? target.schedule.cron;
      const timezone = optionalString(toolInput.timezone) ?? target.schedule.timezone;
      const timingChanged = Boolean(
        optionalString(toolInput.cron) || optionalString(toolInput.timezone),
      );
      const result = await updateGoatTaskScheduleForUser(context.userWorkosId, target.schedule.id, {
        name: optionalString(toolInput.name) ?? target.schedule.name,
        prompt: optionalString(toolInput.prompt) ?? target.schedule.prompt,
        cron,
        timezone,
        sourceDescription:
          optionalString(toolInput.sourceDescription) ??
          ((!timingChanged ? target.schedule.sourceDescription : "") || `${cron} - ${timezone}`),
      });
      if (!result.ok) {
        return {
          ok: false,
          status: "invalid",
          error: result.error,
        } satisfies EditTaskScheduleToolOutput;
      }
      return {
        ok: true,
        scheduleId: result.schedule.id,
        scheduleName: result.schedule.name,
        cron: result.schedule.cron,
        timezone: result.schedule.timezone,
        nextRunAt: result.schedule.nextRunAt.toISOString(),
        status: "updated",
      } satisfies EditTaskScheduleToolOutput;
    }
    case "delete_task_schedule": {
      assertTaskTools(context);
      const schedules = await listGoatTaskSchedulesForUser(context.userWorkosId);
      const target = resolveScheduleTarget(schedules, toolInput);
      if (!target.ok) return target;
      const result = await deleteGoatTaskScheduleForUser(context.userWorkosId, target.schedule.id);
      if (!result.ok) {
        return {
          ok: false,
          status: "invalid",
          error: result.error,
        } satisfies DeleteTaskScheduleToolOutput;
      }
      return {
        ok: true,
        scheduleId: target.schedule.id,
        scheduleName: target.schedule.name,
        status: "deleted",
      } satisfies DeleteTaskScheduleToolOutput;
    }
    case "start_workflow": {
      assertTaskTools(context);
      const created = await createGoatTaskFromWorkflow({
        userWorkosId: context.userWorkosId,
        workspaceId: context.workspaceId,
        mention: { id: requiredString(toolInput.workflowId, "workflowId") },
        description: requiredString(toolInput.prompt, "prompt"),
      });
      return taskResult(created);
    }
    case "browser_use_profile": {
      const profileName = requiredString(toolInput.profile, "profile");
      const profiles = dependencies.browserProfilesAvailable()
        ? await dependencies.listBrowserProfiles(context.userWorkosId)
        : [];
      const profile = profiles.find((candidate) => candidate.name === profileName);
      if (!profile) throw new Error(`Unknown browser profile ${JSON.stringify(profileName)}.`);
      const activeSession = await dependencies.resolveActiveAgentSession({
        userWorkosId: context.userWorkosId,
        chatSessionId: context.chatSessionId,
      });
      if (activeSession?.profile.id === profile.id) {
        return browserProfileResult(activeSession);
      }
      if (activeSession) {
        await dependencies.endAgentSession({
          userWorkosId: context.userWorkosId,
          profileId: activeSession.profile.id,
          sessionId: activeSession.sessionId,
        });
      }
      const session = await dependencies.createAgentSession({
        userWorkosId: context.userWorkosId,
        profileId: profile.id,
        chatSessionId: context.chatSessionId,
        userMessageId: context.userMessageId,
      });
      return browserProfileResult(session);
    }
    case "browser_end_profile": {
      await endActiveBrowserProfile(context, dependencies);
      return { ok: true };
    }
    case "browser": {
      const name = requiredString(toolInput.name, "name");
      if (!isBrowserToolName(name)) throw new Error(`Unsupported browser tool "${name}".`);
      const { createChatBrowserToolSession } = await import("@/lib/sandbox/browser-tools");
      const activeSession = await dependencies.resolveActiveAgentSession({
        userWorkosId: context.userWorkosId,
        chatSessionId: context.chatSessionId,
      });
      return createChatBrowserToolSession({
        chatSessionId: context.chatSessionId,
        userWorkosId: context.userWorkosId,
        signal,
        activeBrowserProfileAgentSession: activeSession,
        endBrowserProfileAgentSession: (session) =>
          dependencies.endAgentSession({
            userWorkosId: context.userWorkosId,
            profileId: session.profile.id,
            sessionId: session.sessionId,
          }),
      }).execute({ name, args: toolInput.args });
    }
    case "wiki": {
      if (!context.wikiEnabled) throw new Error("Wiki is not enabled for this user.");
      return runWikiToolForUser({
        workspaceId: context.workspaceId,
        userWorkosId: context.userWorkosId,
        toolInput: toolInput as never,
      });
    }
  }
}

async function bootstrap(
  context: HostContext,
  input: Record<string, unknown>,
  dependencies: Dependencies,
): Promise<GoatChatHostBootstrap> {
  const mentionedSkillIds = stringArray(input.mentionedSkillIds);
  const [mentionedSkills, skills, workflows, recurringSchedules, browserProfiles] =
    await Promise.all([
      mentionedSkillIds.length
        ? resolveGoatSkillMentions({
            workspaceId: context.workspaceId,
            mentions: mentionedSkillIds.map((id) => ({ id })),
          })
        : Promise.resolve([]),
      listGoatSkillCatalog(context.workspaceId),
      context.taskToolsEnabled ? listGoatWorkflowCatalog(context.workspaceId) : Promise.resolve([]),
      context.taskToolsEnabled
        ? listGoatTaskSchedulesForUser(context.userWorkosId)
        : Promise.resolve([]),
      dependencies.browserProfilesAvailable()
        ? dependencies.listBrowserProfiles(context.userWorkosId)
        : Promise.resolve([]),
    ]);
  const sessionSkills = await activateAndListGoatChatSessionSkills({
    chatSessionId: context.chatSessionId,
    activatedMessageId: context.userMessageId,
    workspaceRef: context.workspaceId,
    skills: mentionedSkills,
  });
  return {
    userContext: {
      email: context.email,
      firstName: context.firstName,
      lastName: context.lastName,
      timezone: context.timezone,
    },
    workspaceName: context.workspaceName,
    taskToolsEnabled: context.taskToolsEnabled,
    wikiEnabled: context.wikiEnabled,
    browserToolsEnabled: true,
    browserProfiles: browserProfiles.map(({ id, name, siteHost }) => ({ id, name, siteHost })),
    skills,
    activeSkills: sessionSkills.map((skill) => ({
      id: skill.skillId,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
    })),
    workflows,
    recurringSchedules,
  };
}

async function endActiveBrowserProfile(context: HostContext, dependencies: Dependencies) {
  const session = await dependencies.resolveActiveAgentSession({
    userWorkosId: context.userWorkosId,
    chatSessionId: context.chatSessionId,
  });
  if (!session) return;
  await dependencies.endAgentSession({
    userWorkosId: context.userWorkosId,
    profileId: session.profile.id,
    sessionId: session.sessionId,
  });
}

async function loadHostContext(
  request: GoatChatHostToolGatewayRequest,
): Promise<HostContext | null> {
  // Cleanup runs after the projector has atomically made the durable turn terminal.
  // Keep every model-visible operation fenced to `running`; the one cleanup operation
  // may resolve the same host-derived identity after settlement so an authenticated
  // browser profile cannot leak when a turn completes, fails, or is canceled.
  const runningTurn =
    request.operation === "browser_end_profile"
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
    .innerJoin(goatWorkspaces, eq(goatWorkspaces.id, goatCodexChatSessions.workspaceId))
    .where(
      and(
        eq(goatCodexChatSessions.id, request.sessionId),
        eq(goatCodexChatSessions.engine, "opencompany"),
        eq(goatCodexChatSessions.hostToolContractVersion, GOAT_CHAT_HOST_TOOL_CONTRACT_VERSION),
        runningTurn,
      ),
    )
    .limit(1);
  if (!row?.workspaceId) return null;
  return {
    userWorkosId: row.userWorkosId,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    chatSessionId: row.chatSessionId,
    userMessageId: row.userMessageId,
    brainRef: row.brainRef,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    timezone: row.timezone,
    taskToolsEnabled: row.taskSpawningEnabled && row.workspaceRole === "admin",
    wikiEnabled: row.wikiEnabled,
  };
}

async function activeBrainRef(context: HostContext) {
  if (context.brainRef) return context.brainRef;
  const brains = await listAccessibleGoatBrains({
    userWorkosId: context.userWorkosId,
    workspaceId: context.workspaceId,
  });
  return (
    brains.find((candidate) => candidate.slug === DEFAULT_GOAT_BRAIN_SLUG)?.id ??
    brains[0]?.id ??
    null
  );
}

function taskResult(task: { id: string; displayId: string; name: string; prompt: string }) {
  return { id: task.id, displayId: task.displayId, name: task.name, prompt: task.prompt };
}

function browserProfileResult(session: {
  profile: { id: string; name: string; siteHost: string };
  liveViewPath: string;
}) {
  return {
    ok: true,
    profile: {
      id: session.profile.id,
      name: session.profile.name,
      siteHost: session.profile.siteHost,
    },
    liveViewUrl: session.liveViewPath,
    message: `Authenticated browser profile active for ${session.profile.siteHost}.`,
  };
}

function assertTaskTools(context: HostContext) {
  if (!context.taskToolsEnabled) throw new Error("Task creation is not enabled for this user.");
}

function requiredModel(value: unknown): AgentModelId {
  const model = requiredString(value, "model");
  if (!AGENT_MODEL_CATALOG.some((candidate) => candidate.id === model)) {
    throw new Error(`Unsupported model "${model}".`);
  }
  return model as AgentModelId;
}

function optionalEngine(value: unknown): GoatHarnessEngine | undefined {
  return value === "opencompany" || value === "codex" || value === "claude_code"
    ? value
    : undefined;
}

function requiredString(value: unknown, field: string) {
  const result = optionalString(value);
  if (!result) throw new Error(`${field} is required.`);
  return result;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
            .map((item) => item.trim()),
        ),
      ]
    : [];
}

function resolveScheduleTarget(
  schedules: Awaited<ReturnType<typeof listGoatTaskSchedulesForUser>>,
  input: Record<string, unknown>,
):
  | { ok: true; schedule: (typeof schedules)[number] }
  | { ok: false; error: string; status: "not_found" | "ambiguous" | "invalid" } {
  const scheduleId = optionalString(input.scheduleId);
  if (scheduleId) {
    const schedule = schedules.find((candidate) => candidate.id === scheduleId);
    return schedule
      ? { ok: true, schedule }
      : { ok: false, status: "not_found", error: "Recurring task not found." };
  }
  const scheduleName = optionalString(input.scheduleName);
  if (!scheduleName) {
    return { ok: false, status: "invalid", error: "Specify which recurring task to change." };
  }
  const normalized = normalizeLookup(scheduleName);
  const matches = schedules.filter((schedule) => normalizeLookup(schedule.name) === normalized);
  if (matches.length === 1 && matches[0]) return { ok: true, schedule: matches[0] };
  if (matches.length > 1) {
    return {
      ok: false,
      status: "ambiguous",
      error: "Multiple recurring tasks matched that name. Ask which one to change.",
    };
  }
  return { ok: false, status: "not_found", error: "Recurring task not found." };
}

function normalizeLookup(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
}

function failure(error: string): GoatChatHostToolGatewayResponse {
  return { ok: false, error };
}
