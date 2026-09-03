import { createHash } from "node:crypto";
import {
  AGENT_MODEL_CATALOG,
  type ChatHostBootstrap,
  type ChatHostSkillFileChunk,
  type ChatHostToolGatewayResponse,
  type ChatHostToolOperation,
  isClaudeCodeModelId,
  isCodexModelId,
} from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { isBrowserToolName } from "@opencompany/browser-tools";
import { type Actor, SKILL_WRITE_PERMISSION } from "@opencompany/core";
import type { DeleteTaskScheduleToolOutput, EditTaskScheduleToolOutput } from "../chat-ui";

export type ChatHostContext = {
  actorId: string;
  workspaceId: string;
  workspaceName: string;
  conversationId: string;
  messageId: string;
  brainRef: string | null;
  email: string;
  firstName: string | null;
  lastName: string | null;
  timezone: string;
  taskToolsEnabled: boolean;
  skillToolsEnabled: boolean;
  wikiEnabled: boolean;
};

export type ChatHostToolCommand = {
  operation: ChatHostToolOperation;
  sessionId: string;
  runId: string;
  input?: Record<string, unknown>;
  /** Stable AI-SDK tool-call id, when the operation has one (see gateway request). */
  toolCallId?: string;
};

type BrowserProfile = {
  id: string;
  name: string;
  siteHost: string;
  allowedHosts: string[];
};

type BrowserProfileSession = {
  profile: BrowserProfile;
  sessionId: string;
  connectUrl: string;
  liveViewPath: string;
  startedAt: Date;
};

type MentionedSkill = {
  id: string;
  bundleId: string;
  name: string;
  description: string;
  instructions: string;
  sourceKind: "standalone" | "plugin";
};

type ActiveSkill = {
  skillId: string;
  name: string;
  description: string;
  instructions: string;
};

type ScheduleView = {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string;
  prompt: string;
  sourceDescription: string;
};

type TaskResult = { id: string; displayId: string; name: string; prompt: string };

export type ChatHostToolServiceDependencies = {
  loadContext: (command: ChatHostToolCommand) => Promise<ChatHostContext | null>;
  listBrains: (input: {
    actorId: string;
    workspaceId: string;
  }) => Promise<readonly { id: string; slug: string }[]>;
  defaultBrainSlug: string;
  browserProfilesAvailable: () => boolean;
  createAgentSession: (input: {
    actorId: string;
    profileId: string;
    conversationId: string;
    messageId: string;
  }) => Promise<BrowserProfileSession>;
  endAgentSession: (input: {
    actorId: string;
    profileId: string;
    sessionId: string;
  }) => Promise<unknown>;
  listBrowserProfiles: (actorId: string) => Promise<BrowserProfile[]>;
  resolveActiveAgentSession: (input: {
    actorId: string;
    conversationId: string;
  }) => Promise<BrowserProfileSession | null>;
  resolveSkillMentions: (input: {
    workspaceId: string;
    mentions: { id: string }[];
  }) => Promise<MentionedSkill[]>;
  listSkillCatalog: (
    workspaceId: string,
  ) => Promise<Array<{ id: string; name: string; description: string }>>;
  activateAndListSkills: (input: {
    conversationId: string;
    messageId: string;
    workspaceId: string;
    skills: MentionedSkill[];
  }) => Promise<ActiveSkill[]>;
  readSkillFile: (input: {
    workspaceId: string;
    conversationId: string;
    skill: string;
    path: string;
    offset?: number;
    maxBytes?: number;
  }) => Promise<ChatHostSkillFileChunk>;
  createWorkspaceSkill: (input: {
    actor: Actor;
    idempotencyKey: string;
    skill: { name: string; description: string; instructions: string };
  }) => Promise<{ created: true; name: string; command: string; bundleId: string }>;
  updateWorkspaceSkill: (input: {
    actor: Actor;
    name: string;
    skill: { description: string; instructions: string };
  }) => Promise<{ updated: true; name: string; command: string; bundleId: string }>;
  createTask: (input: {
    actorId: string;
    workspaceId: string;
    brainRef: string | null;
    prompt: string;
    model: AgentModelId;
    name?: string;
    engine?: "opencompany" | "codex" | "claude_code";
  }) => Promise<TaskResult>;
  listSchedules: (actorId: string) => Promise<ScheduleView[]>;
  createSchedule: (input: {
    actorId: string;
    workspaceId: string;
    name: string;
    sourceDescription: string;
    cron: string;
    timezone: string;
    prompt: string;
  }) => Promise<{
    id: string;
    name: string;
    cron: string;
    timezone: string;
    nextRunAt: Date;
    prompt: string;
  }>;
  updateSchedule: (
    actorId: string,
    scheduleId: string,
    input: {
      name: string;
      prompt: string;
      cron: string;
      timezone: string;
      sourceDescription: string;
    },
  ) => Promise<
    | {
        ok: true;
        schedule: {
          id: string;
          name: string;
          cron: string;
          timezone: string;
          nextRunAt: Date;
        };
      }
    | { ok: false; error: string }
  >;
  deleteSchedule: (
    actorId: string,
    scheduleId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  createWorkflowTask: (input: {
    actorId: string;
    workspaceId: string;
    mention: { id: string };
    description: string;
  }) => Promise<TaskResult>;
  listWorkflowCatalog: (
    workspaceId: string,
  ) => Promise<Array<{ id: string; name: string; description: string }>>;
  executeBrowserTool: (input: {
    context: ChatHostContext;
    name: ReturnType<typeof browserToolName>;
    args: unknown;
    activeSession: BrowserProfileSession | null;
    signal: AbortSignal;
  }) => Promise<unknown>;
  runWikiTool: (input: {
    workspaceId: string;
    actorId: string;
    toolInput: Record<string, unknown>;
    /** Stable per-tool-call key, e.g. `agent-wiki:<turnId>:<toolCallId>`. */
    idempotencyKey: string;
  }) => Promise<unknown>;
  onRejected?: (command: ChatHostToolCommand) => void;
  onCompleted?: (command: ChatHostToolCommand, durationMs: number) => void;
  onFailed?: (command: ChatHostToolCommand, durationMs: number, error: unknown) => void;
};

export async function executeChatHostToolService(input: {
  command: ChatHostToolCommand;
  signal?: AbortSignal;
  dependencies: ChatHostToolServiceDependencies;
}): Promise<ChatHostToolGatewayResponse> {
  const { dependencies } = input;
  const context = await dependencies.loadContext(input.command);
  if (!context) {
    dependencies.onRejected?.(input.command);
    return failure("This Chat turn can no longer use host tools.");
  }
  const startedAt = Date.now();
  try {
    const response: ChatHostToolGatewayResponse = {
      ok: true,
      result: await executeOperation(
        context,
        input.command,
        input.signal ?? new AbortController().signal,
        dependencies,
      ),
    };
    dependencies.onCompleted?.(input.command, Date.now() - startedAt);
    return response;
  } catch (error) {
    dependencies.onFailed?.(input.command, Date.now() - startedAt, error);
    return failure(error instanceof Error ? error.message : "The Chat host tool failed.");
  }
}

async function executeOperation(
  context: ChatHostContext,
  command: ChatHostToolCommand,
  signal: AbortSignal,
  dependencies: ChatHostToolServiceDependencies,
): Promise<unknown> {
  const toolInput = command.input ?? {};
  switch (command.operation) {
    case "bootstrap":
      return bootstrap(context, toolInput, dependencies);
    case "use_skill": {
      const skill = requiredString(toolInput.skill, "skill");
      const [resolved] = await dependencies.resolveSkillMentions({
        workspaceId: context.workspaceId,
        mentions: [{ id: skill }],
      });
      if (!resolved) throw new Error(`Skill "@skill/${skill}" is unavailable or incomplete.`);
      const active = await dependencies.activateAndListSkills({
        conversationId: context.conversationId,
        messageId: context.messageId,
        workspaceId: context.workspaceId,
        skills: [resolved],
      });
      const fixed = active.find((candidate) => candidate.skillId === skill);
      if (!fixed) throw new Error(`Skill "@skill/${skill}" could not be activated.`);
      return {
        ok: true,
        skill: {
          id: fixed.skillId,
          name: fixed.name,
          description: fixed.description,
          instructions: fixed.instructions,
        },
      };
    }
    case "read_skill_file": {
      const offset = optionalInteger(toolInput.offset, "offset");
      const maxBytes = optionalInteger(toolInput.maxBytes, "maxBytes");
      return dependencies.readSkillFile({
        workspaceId: context.workspaceId,
        conversationId: context.conversationId,
        skill: requiredString(toolInput.skill, "skill"),
        path: requiredString(toolInput.path, "path"),
        ...(offset !== undefined ? { offset } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      });
    }
    case "create_workspace_skill": {
      assertSkillTools(context);
      return dependencies.createWorkspaceSkill({
        actor: {
          userId: context.actorId,
          workspaceId: context.workspaceId,
          role: "admin",
          permissions: [SKILL_WRITE_PERMISSION],
          authenticationMethod: "service",
        },
        idempotencyKey: workspaceSkillIdempotencyKey(command.runId, command.toolCallId),
        skill: {
          name: requiredString(toolInput.name, "name"),
          description: requiredString(toolInput.description, "description"),
          instructions: requiredString(toolInput.instructions, "instructions"),
        },
      });
    }
    case "edit_workspace_skill": {
      assertSkillTools(context);
      return dependencies.updateWorkspaceSkill({
        actor: {
          userId: context.actorId,
          workspaceId: context.workspaceId,
          role: "admin",
          permissions: [SKILL_WRITE_PERMISSION],
          authenticationMethod: "service",
        },
        name: requiredString(toolInput.name, "name"),
        skill: {
          description: requiredString(toolInput.description, "description"),
          instructions: requiredString(toolInput.instructions, "instructions"),
        },
      });
    }
    case "start_task": {
      assertTaskTools(context);
      const model = requiredModel(toolInput.model);
      const name = optionalString(toolInput.name);
      const engine = optionalEngine(toolInput.engine);
      assertModelSupportsEngine(model, engine);
      const created = await dependencies.createTask({
        actorId: context.actorId,
        workspaceId: context.workspaceId,
        brainRef: await activeBrainRef(context, dependencies),
        prompt: requiredString(toolInput.prompt, "prompt"),
        model,
        ...(name ? { name } : {}),
        ...(engine ? { engine } : {}),
      });
      return taskResult(created);
    }
    case "schedule_task": {
      assertTaskTools(context);
      const created = await dependencies.createSchedule({
        actorId: context.actorId,
        workspaceId: context.workspaceId,
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
      const schedules = await dependencies.listSchedules(context.actorId);
      const target = resolveScheduleTarget(schedules, toolInput);
      if (!target.ok) return target;
      const cron = optionalString(toolInput.cron) ?? target.schedule.cron;
      const timezone = optionalString(toolInput.timezone) ?? target.schedule.timezone;
      const timingChanged = Boolean(
        optionalString(toolInput.cron) || optionalString(toolInput.timezone),
      );
      const result = await dependencies.updateSchedule(context.actorId, target.schedule.id, {
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
      const schedules = await dependencies.listSchedules(context.actorId);
      const target = resolveScheduleTarget(schedules, toolInput);
      if (!target.ok) return target;
      const result = await dependencies.deleteSchedule(context.actorId, target.schedule.id);
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
      const created = await dependencies.createWorkflowTask({
        actorId: context.actorId,
        workspaceId: context.workspaceId,
        mention: { id: requiredString(toolInput.workflowId, "workflowId") },
        description: requiredString(toolInput.prompt, "prompt"),
      });
      return taskResult(created);
    }
    case "browser_use_profile": {
      const profileName = requiredString(toolInput.profile, "profile");
      const profiles = dependencies.browserProfilesAvailable()
        ? await dependencies.listBrowserProfiles(context.actorId)
        : [];
      const profile = profiles.find((candidate) => candidate.name === profileName);
      if (!profile) throw new Error(`Unknown browser profile ${JSON.stringify(profileName)}.`);
      const activeSession = await dependencies.resolveActiveAgentSession({
        actorId: context.actorId,
        conversationId: context.conversationId,
      });
      if (activeSession?.profile.id === profile.id) return browserProfileResult(activeSession);
      if (activeSession) {
        await dependencies.endAgentSession({
          actorId: context.actorId,
          profileId: activeSession.profile.id,
          sessionId: activeSession.sessionId,
        });
      }
      const session = await dependencies.createAgentSession({
        actorId: context.actorId,
        profileId: profile.id,
        conversationId: context.conversationId,
        messageId: context.messageId,
      });
      return browserProfileResult(session);
    }
    case "browser_end_profile":
      await endActiveBrowserProfile(context, dependencies);
      return { ok: true };
    case "browser": {
      const name = browserToolName(toolInput.name);
      const activeSession = await dependencies.resolveActiveAgentSession({
        actorId: context.actorId,
        conversationId: context.conversationId,
      });
      return dependencies.executeBrowserTool({
        context,
        name,
        args: toolInput.args,
        activeSession,
        signal,
      });
    }
    case "wiki":
      if (!context.wikiEnabled) throw new Error("Wiki is not enabled for this user.");
      return dependencies.runWikiTool({
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        toolInput,
        // Stable execution identity: same (turn, tool call) → same key on retry;
        // two intentional wiki calls in one turn get different keys.
        idempotencyKey: `agent-wiki:${command.runId}:${command.toolCallId ?? command.sessionId}`,
      });
  }
}

async function bootstrap(
  context: ChatHostContext,
  input: Record<string, unknown>,
  dependencies: ChatHostToolServiceDependencies,
): Promise<ChatHostBootstrap> {
  const mentionedSkillIds = stringArray(input.mentionedSkillIds);
  const [mentionedSkills, skills, workflows, recurringSchedules, browserProfiles] =
    await Promise.all([
      mentionedSkillIds.length
        ? dependencies.resolveSkillMentions({
            workspaceId: context.workspaceId,
            mentions: mentionedSkillIds.map((id) => ({ id })),
          })
        : Promise.resolve([]),
      dependencies.listSkillCatalog(context.workspaceId),
      context.taskToolsEnabled
        ? dependencies.listWorkflowCatalog(context.workspaceId)
        : Promise.resolve([]),
      context.taskToolsEnabled ? dependencies.listSchedules(context.actorId) : Promise.resolve([]),
      dependencies.browserProfilesAvailable()
        ? dependencies.listBrowserProfiles(context.actorId)
        : Promise.resolve([]),
    ]);
  const sessionSkills = await dependencies.activateAndListSkills({
    conversationId: context.conversationId,
    messageId: context.messageId,
    workspaceId: context.workspaceId,
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
    skillToolsEnabled: context.skillToolsEnabled,
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

async function activeBrainRef(
  context: ChatHostContext,
  dependencies: ChatHostToolServiceDependencies,
) {
  if (context.brainRef) return context.brainRef;
  const brains = await dependencies.listBrains({
    actorId: context.actorId,
    workspaceId: context.workspaceId,
  });
  return (
    brains.find((candidate) => candidate.slug === dependencies.defaultBrainSlug)?.id ??
    brains[0]?.id ??
    null
  );
}

async function endActiveBrowserProfile(
  context: ChatHostContext,
  dependencies: ChatHostToolServiceDependencies,
) {
  const session = await dependencies.resolveActiveAgentSession({
    actorId: context.actorId,
    conversationId: context.conversationId,
  });
  if (!session) return;
  await dependencies.endAgentSession({
    actorId: context.actorId,
    profileId: session.profile.id,
    sessionId: session.sessionId,
  });
}

function taskResult(task: TaskResult) {
  return { id: task.id, displayId: task.displayId, name: task.name, prompt: task.prompt };
}

function browserProfileResult(session: BrowserProfileSession) {
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

function assertTaskTools(context: ChatHostContext) {
  if (!context.taskToolsEnabled) throw new Error("Task creation is not enabled for this user.");
}

function assertSkillTools(context: ChatHostContext) {
  if (!context.skillToolsEnabled) {
    throw new Error("Only workspace admins can manage Skills from Chat.");
  }
}

export function workspaceSkillIdempotencyKey(turnId: string, toolCallId?: string) {
  const invocationHash = createHash("sha256")
    .update(`${turnId}:${toolCallId ?? "create-workspace-skill"}`)
    .digest("hex");
  return `agent-skill:${invocationHash}`;
}

function requiredModel(value: unknown): AgentModelId {
  const model = requiredString(value, "model");
  if (!AGENT_MODEL_CATALOG.some((candidate) => candidate.id === model)) {
    throw new Error(`Unsupported model "${model}".`);
  }
  return model as AgentModelId;
}

function optionalEngine(value: unknown) {
  return value === "opencompany" || value === "codex" || value === "claude_code"
    ? value
    : undefined;
}

function assertModelSupportsEngine(
  model: AgentModelId,
  engine: "opencompany" | "codex" | "claude_code" | undefined,
) {
  if (engine === "codex" && !isCodexModelId(model)) {
    throw new Error(`Model "${model}" is not available for the Codex engine.`);
  }
  if (engine === "claude_code" && !isClaudeCodeModelId(model)) {
    throw new Error(`Model "${model}" is not available for the Claude Code engine.`);
  }
}

function browserToolName(value: unknown) {
  const name = requiredString(value, "name");
  if (!isBrowserToolName(name)) throw new Error(`Unsupported browser tool "${name}".`);
  return name;
}

function requiredString(value: unknown, field: string) {
  const result = optionalString(value);
  if (!result) throw new Error(`${field} is required.`);
  return result;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalInteger(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer.`);
  return value as number;
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
  schedules: ScheduleView[],
  input: Record<string, unknown>,
):
  | { ok: true; schedule: ScheduleView }
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

function failure(error: string): ChatHostToolGatewayResponse {
  return { ok: false, error };
}
