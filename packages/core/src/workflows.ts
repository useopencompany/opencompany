import {
  type Actor,
  actorHasPermission,
  SCHEDULE_READ_PERMISSION,
  SCHEDULE_WRITE_PERMISSION,
  WORKFLOW_READ_PERMISSION,
  WORKFLOW_WRITE_PERMISSION,
} from "./actor";
import { CHAT_ENGINES, type ChatEngine, CoreError } from "./chat";
import type { CreateTaskResult } from "./tasks";

export const WORKFLOW_STATUSES = ["draft", "active"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

// A company workflow belongs to the workspace: every member can see, run, and edit it. A personal
// workflow is only visible to its creator. Workflows that predate scopes are company workflows.
export const WORKFLOW_SCOPES = ["personal", "company"] as const;
export type WorkflowScope = (typeof WORKFLOW_SCOPES)[number];

// Only the creator changes a workflow's visibility; an admin can additionally claim one that
// predates scopes and has no recorded creator. Admins deliberately cannot take someone else's
// workflow personal: a scheduled or event-driven workflow fires as a specific user, and that
// identity has to stay the owner. Archiving is the honest way to retire a teammate's workflow.
export function canManageWorkflowScope(
  actor: Pick<Actor, "userId" | "role">,
  workflow: Pick<Workflow, "createdByUserId">,
) {
  return (
    workflow.createdByUserId === actor.userId ||
    (workflow.createdByUserId === null && actor.role === "admin")
  );
}

// Slack is the only channel a workflow can post to today. The toggle decides whether the run gets
// the Slack send tool at all; the name and avatar are cosmetic overrides on the post itself.
export type WorkflowSlackChannel = {
  enabled: boolean;
  displayName: string;
  avatarUrl: string;
};

export type WorkflowStep = {
  id: string;
  title: string;
  model: string;
  runtimeModel?: string;
  reasoningEffort?: string;
  instructions: string;
};

// The prompt a schedule trigger carries when the author never wrote extra run context. It is a
// placeholder, not an instruction, so every run path substitutes the first step's instructions for
// it. Defined here because `@opencompany/agent` re-exports it and depends on core, not the reverse.
export const DEFAULT_WORKFLOW_SCHEDULE_PROMPT = "Run this workflow.";

export function workflowActivationDisabledReason(steps: Pick<WorkflowStep, "instructions">[]) {
  if (steps.length === 0) return "Add a step with instructions before activating this workflow.";
  const emptySteps = steps.flatMap((step, index) => (step.instructions.trim() ? [] : [index + 1]));
  if (emptySteps.length === 0) return null;
  return `Add instructions to ${emptySteps.length === 1 ? "step" : "steps"} ${emptySteps.join(", ")} before activating this workflow.`;
}

export type WorkflowEventFilterValue = {
  id: string;
  name: string;
  key?: string;
  metadata?: Record<string, string>;
};

export type WorkflowEventTrigger = {
  type: "event";
  provider: string;
  event: string;
  integrationId: string;
  filters: Record<string, WorkflowEventFilterValue>;
  prompt: string;
};

export type WorkflowTrigger =
  | { type: "manual" }
  | WorkflowEventTrigger
  | {
      type: "schedule";
      cron: string;
      timezone: string;
      prompt: string;
      enabled: boolean;
      lastRunAt: Date | null;
      nextRunAt: Date | null;
    };

export type WorkflowTriggerInput =
  | { type: "manual" }
  | (Omit<WorkflowEventTrigger, "prompt"> & { prompt?: string | null })
  | {
      type: "schedule";
      cron: string;
      timezone?: string | null;
      prompt?: string | null;
      enabled?: boolean;
    };

export type WorkflowAutomationTrigger =
  | ({ id: string } & WorkflowEventTrigger)
  | {
      id: string;
      type: "schedule";
      cron: string;
      timezone: string;
      prompt: string;
      enabled: boolean;
      lastRunAt: Date | null;
      nextRunAt: Date | null;
    };

export type WorkflowAutomationTriggerInput =
  | ({ id: string } & Omit<WorkflowEventTrigger, "prompt"> & { prompt?: string | null })
  | {
      id: string;
      type: "schedule";
      cron: string;
      timezone?: string | null;
      prompt?: string | null;
      enabled?: boolean;
    };

type NormalizedWorkflowTriggerInput =
  | { type: "manual" }
  | Extract<WorkflowTrigger, { type: "event" }>
  | {
      type: "schedule";
      cron: string;
      timezone: string;
      prompt: string;
      enabled: boolean;
    };

export type Workflow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  status: WorkflowStatus;
  scope: WorkflowScope;
  slackChannel: WorkflowSlackChannel;
  createdByUserId: string | null;
  trigger: WorkflowTrigger;
  triggers?: WorkflowAutomationTrigger[];
  version: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkflowPage = {
  workflows: Workflow[];
  nextCursor: string | null;
};

// A workflow's single markdown memory. `updatedAt` is null until a run writes one.
export type WorkflowMemory = {
  workflowId: string;
  enabled: boolean;
  content: string;
  updatedAt: Date | null;
};

// Memory is injected into every run's system context, so its size is a context-window cost paid on
// each run rather than storage the workflow can grow without bound. Writes above the cap are
// rejected with the limit in the message so the model can re-summarize and retry.
export const WORKFLOW_MEMORY_MAX_CHARACTERS = 20_000;

export type TaskSchedule = {
  id: string;
  name: string;
  sourceDescription: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskSchedulePage = {
  schedules: TaskSchedule[];
  nextCursor: string | null;
};

export type AutomationExecutionPlan = {
  engine: ChatEngine;
  model: string;
  payload: unknown;
};

export type ScheduleDefinition = {
  cron: string;
  timezone: string;
  nextRunAt: Date;
};

export interface ScheduleRules {
  normalize(input: {
    cron: string;
    timezone?: string | null;
    now: Date;
  }): ScheduleDefinition | null;
}

export interface AutomationExecutionPlanner {
  prepareWorkflow(input: {
    actor: Actor;
    workflow: Workflow;
    prompt: string;
    skillIds?: readonly string[];
  }): Promise<AutomationExecutionPlan>;
  prepareTaskSchedule(input: { actor: Actor; prompt: string }): Promise<AutomationExecutionPlan>;
}

export interface AutomationTaskCreator {
  create(input: {
    actor: Actor;
    idempotencyKey: string;
    name: string;
    goal: string;
    execution: AutomationExecutionPlan;
    source: "workflow" | "schedule";
    workflowId?: string;
    scheduleId?: string;
    attachmentIds?: readonly string[];
  }): Promise<CreateTaskResult>;
}

export type WorkflowMutationResult = {
  workflow: Workflow;
  transactionId: string;
  idempotentReplay: boolean;
};

export type WorkflowVersionResult = {
  workflow: Workflow;
  transactionId: string;
};

export type WorkflowArchiveResult = {
  workflowId: string;
  version: number;
  transactionId: string;
};

export type TaskScheduleMutationResult = {
  schedule: TaskSchedule;
  transactionId: string;
  idempotentReplay: boolean;
};

export type TaskScheduleVersionResult = {
  schedule: TaskSchedule;
  transactionId: string;
};

export type TaskScheduleArchiveResult = {
  scheduleId: string;
  version: number;
  transactionId: string;
};

export type VersionedRepositoryResult<T> =
  | { status: "updated"; value: T; transactionId: string }
  | { status: "conflict" }
  | { status: "not_found" };

export interface WorkflowRepository {
  listWorkflows(input: { actor: Actor; cursor?: string; limit: number }): Promise<WorkflowPage>;
  getWorkflow(input: { actor: Actor; workflowId: string }): Promise<Workflow | null>;
  createWorkflow(input: {
    actor: Actor;
    idempotencyKey: string;
    name: string;
    description: string;
    scope: WorkflowScope;
    initialStep: WorkflowStep;
  }): Promise<WorkflowMutationResult>;
  updateWorkflow(input: {
    actor: Actor;
    workflowId: string;
    expectedVersion: number;
    name: string;
    description: string;
    steps: WorkflowStep[];
    status: WorkflowStatus;
    scope: WorkflowScope;
    slackChannel: WorkflowSlackChannel;
    trigger: WorkflowTriggerInput;
    automationTriggers?: Array<{
      trigger: WorkflowAutomationTrigger;
      userWorkosId: string;
      activatedAt: Date;
      execution?: AutomationExecutionPlan;
    }>;
    schedule?: {
      definition: ScheduleDefinition;
      execution?: AutomationExecutionPlan;
    };
    event?: { execution?: AutomationExecutionPlan };
  }): Promise<VersionedRepositoryResult<Workflow>>;
  archiveWorkflow(input: {
    actor: Actor;
    workflowId: string;
    expectedVersion: number;
  }): Promise<VersionedRepositoryResult<{ workflowId: string; version: number }>>;
  recordRunNow(input: {
    actor: Actor;
    workflowId: string;
    taskId: string;
    occurredAt: Date;
  }): Promise<void>;
  getWorkflowMemory(input: { actor: Actor; workflowId: string }): Promise<WorkflowMemory | null>;
  setWorkflowMemoryEnabled(input: {
    actor: Actor;
    workflowId: string;
    enabled: boolean;
  }): Promise<WorkflowMemory | null>;
  clearWorkflowMemory(input: { actor: Actor; workflowId: string }): Promise<WorkflowMemory | null>;
}

export interface TaskScheduleRepository {
  assertTaskScheduleWriteAllowed(actor: Actor): Promise<void>;
  replayTaskScheduleCreate(input: {
    actor: Actor;
    idempotencyKey: string;
    name: string;
    sourceDescription: string;
    prompt: string;
    schedule: ScheduleDefinition;
  }): Promise<TaskScheduleMutationResult | null>;
  listTaskSchedules(input: {
    actor: Actor;
    cursor?: string;
    limit: number;
  }): Promise<TaskSchedulePage>;
  getTaskSchedule(input: { actor: Actor; scheduleId: string }): Promise<TaskSchedule | null>;
  createTaskSchedule(input: {
    actor: Actor;
    idempotencyKey: string;
    name: string;
    sourceDescription: string;
    prompt: string;
    schedule: ScheduleDefinition;
    execution: AutomationExecutionPlan;
  }): Promise<TaskScheduleMutationResult>;
  updateTaskSchedule(input: {
    actor: Actor;
    scheduleId: string;
    expectedVersion: number;
    name: string;
    sourceDescription: string;
    prompt: string;
    schedule: ScheduleDefinition;
    execution: AutomationExecutionPlan;
  }): Promise<VersionedRepositoryResult<TaskSchedule>>;
  setTaskScheduleEnabled(input: {
    actor: Actor;
    scheduleId: string;
    expectedVersion: number;
    enabled: boolean;
    nextRunAt?: Date;
  }): Promise<VersionedRepositoryResult<TaskSchedule>>;
  archiveTaskSchedule(input: {
    actor: Actor;
    scheduleId: string;
    expectedVersion: number;
  }): Promise<VersionedRepositoryResult<{ scheduleId: string; version: number }>>;
  loadTaskScheduleExecution(input: {
    actor: Actor;
    scheduleId: string;
  }): Promise<{ schedule: TaskSchedule; execution: AutomationExecutionPlan } | null>;
  recordRunNow(input: {
    actor: Actor;
    scheduleId: string;
    taskId: string;
    occurredAt: Date;
  }): Promise<void>;
}

export type WorkflowDefinitionValidator = (input: {
  name: string;
  description: string;
  steps: WorkflowStep[];
  status: WorkflowStatus;
  trigger: WorkflowTriggerInput;
}) => string | null;

type WorkflowApplicationServiceOptions = {
  scheduleRules: ScheduleRules;
  planner: AutomationExecutionPlanner;
  taskCreator: AutomationTaskCreator;
  validateDefinition?: WorkflowDefinitionValidator;
  validateEventSubscription?: (input: {
    actor: Actor;
    trigger: WorkflowEventTrigger;
  }) => Promise<string | null>;
  now?: () => Date;
  newStepId?: () => string;
};

type TaskScheduleApplicationServiceOptions = {
  scheduleRules: ScheduleRules;
  planner: AutomationExecutionPlanner;
  taskCreator: AutomationTaskCreator;
  now?: () => Date;
};

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_RESOURCE_ID_LENGTH = 256;
const MAX_WORKFLOW_NAME_LENGTH = 64;
const MAX_WORKFLOW_DESCRIPTION_LENGTH = 1_024;
const MAX_WORKFLOW_STEPS = 20;
const MAX_STEP_ID_LENGTH = 200;
const MAX_STEP_TITLE_LENGTH = 120;
const MAX_STEP_MODEL_LENGTH = 256;
const MAX_STEP_INSTRUCTIONS_LENGTH = 20_000;
const MAX_PROMPT_LENGTH = 10_000;
const MAX_SCHEDULE_NAME_LENGTH = 80;
const MAX_SOURCE_DESCRIPTION_LENGTH = 1_024;
const MAX_WORKFLOW_SKILLS = 16;
// Slack truncates long custom usernames on the message itself; keep the stored value inside a
// length Slack renders in full. Exported so the editor's input cap cannot drift from validation.
export const MAX_SLACK_DISPLAY_NAME_LENGTH = 80;
export const MAX_SLACK_AVATAR_URL_LENGTH = 2_048;

// An uploaded avatar is served back to Slack as-is, so the accepted set is the three formats
// Slack renders and every browser can produce. 1 MB is far above a square icon and far below
// anything worth streaming.
export const WORKFLOW_AVATAR_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type WorkflowAvatarMediaType = (typeof WORKFLOW_AVATAR_MEDIA_TYPES)[number];
export const WORKFLOW_AVATAR_MAX_BYTES = 1024 * 1024;

export class WorkflowApplicationService {
  constructor(
    private readonly repository: WorkflowRepository,
    private readonly options: WorkflowApplicationServiceOptions,
  ) {}

  listWorkflows(
    actor: Actor,
    input: { cursor?: string; limit?: number } = {},
  ): Promise<WorkflowPage> {
    requirePermission(actor, WORKFLOW_READ_PERMISSION, "Workflows");
    return this.repository.listWorkflows({
      actor,
      ...(input.cursor ? { cursor: resourceId(input.cursor, "cursor") } : {}),
      limit: Math.max(1, Math.min(input.limit ?? 50, 100)),
    });
  }

  async getWorkflow(actor: Actor, workflowId: string): Promise<Workflow> {
    requirePermission(actor, WORKFLOW_READ_PERMISSION, "Workflows");
    const workflow = await this.repository.getWorkflow({
      actor,
      workflowId: resourceId(workflowId, "workflowId"),
    });
    if (!workflow) throw new CoreError("not_found", "Workflow not found.");
    return workflow;
  }

  // Authorizes a side-channel write against a workflow the actor can already edit — today the
  // Slack avatar upload, which stores bytes before the editor saves the resulting URL through
  // `updateWorkflow`. Returns the normalized id so callers never build a path from raw input.
  async authorizeWorkflowWrite(actor: Actor, workflowId: string): Promise<string> {
    requirePermission(actor, WORKFLOW_WRITE_PERMISSION, "Workflows");
    const id = resourceId(workflowId, "workflowId");
    const workflow = await this.repository.getWorkflow({ actor, workflowId: id });
    if (!workflow) throw new CoreError("not_found", "Workflow not found.");
    return id;
  }

  createWorkflow(
    actor: Actor,
    input: {
      idempotencyKey: string;
      name: string;
      description?: string;
      scope?: WorkflowScope;
    },
  ): Promise<WorkflowMutationResult> {
    requirePermission(actor, WORKFLOW_WRITE_PERMISSION, "Workflows");
    const name = workflowName(input.name);
    const description = workflowDescription(input.description ?? "");
    const scope = workflowScope(input.scope ?? "company");
    const initialStep: WorkflowStep = {
      id: resourceId(this.options.newStepId?.() ?? crypto.randomUUID(), "stepId"),
      title: "",
      model: "",
      instructions: "",
    };
    validateWorkflowDefinition(
      { name, description, steps: [initialStep], status: "draft", trigger: { type: "manual" } },
      this.options.validateDefinition,
    );
    return this.repository.createWorkflow({
      actor,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      name,
      description,
      scope,
      initialStep,
    });
  }

  async updateWorkflow(
    actor: Actor,
    workflowId: string,
    input: {
      expectedVersion: number;
      name: string;
      description: string;
      steps: WorkflowStep[];
      status: WorkflowStatus;
      scope?: WorkflowScope;
      // Omitted leaves the current channel configuration untouched.
      slackChannel?: WorkflowSlackChannel;
      trigger: WorkflowTriggerInput;
      triggers?: WorkflowAutomationTriggerInput[];
    },
  ): Promise<WorkflowVersionResult> {
    requirePermission(actor, WORKFLOW_WRITE_PERMISSION, "Workflows");
    const id = resourceId(workflowId, "workflowId");
    const expectedVersion = version(input.expectedVersion);
    const current = await this.repository.getWorkflow({ actor, workflowId: id });
    if (!current) throw new CoreError("not_found", "Workflow not found.");
    if (current.version !== expectedVersion) throw versionConflict("Workflow");
    const scope = input.scope === undefined ? current.scope : workflowScope(input.scope);
    const slackChannel =
      input.slackChannel === undefined
        ? current.slackChannel
        : workflowSlackChannel(input.slackChannel);
    if (scope !== current.scope && !canManageWorkflowScope(actor, current)) {
      throw new CoreError(
        "forbidden",
        "Only the creator or a workspace admin can change this workflow's visibility.",
      );
    }
    const normalized = normalizeWorkflowDefinition(
      {
        ...input,
        triggers: input.triggers ?? automationTriggersFromLegacyUpdate(current, input.trigger),
      },
      this.options.validateDefinition,
    );
    const { triggers: normalizedTriggers, ...normalizedDefinition } = normalized;
    const activationError = workflowActivationDisabledReason(normalized.steps);
    if (normalized.status === "active" && activationError) {
      throw new CoreError("invalid_argument", activationError);
    }
    const now = this.options.now?.() ?? new Date();
    if (normalizedTriggers) {
      const currentTriggers = new Map(
        (current.triggers ?? []).map((trigger) => [trigger.id, trigger]),
      );
      const automationTriggers = await Promise.all(
        normalizedTriggers.map(async (trigger) => {
          if (trigger.type === "event") {
            const publicTrigger: WorkflowAutomationTrigger = {
              ...trigger,
              prompt: trigger.prompt?.trim() || "Run this workflow.",
            };
            const subscriptionError = await this.options.validateEventSubscription?.({
              actor,
              trigger: publicTrigger,
            });
            if (subscriptionError) throw new CoreError("invalid_argument", subscriptionError);
            const execution =
              normalized.status === "active"
                ? validatedExecution(
                    await this.options.planner.prepareWorkflow({
                      actor,
                      workflow: {
                        ...current,
                        ...normalizedDefinition,
                        scope,
                        trigger: workflowTriggerWithoutId(publicTrigger),
                      },
                      prompt: publicTrigger.prompt,
                    }),
                  )
                : undefined;
            return {
              trigger: publicTrigger,
              userWorkosId: actor.userId,
              activatedAt: now,
              ...(execution ? { execution } : {}),
            };
          }

          const definition = this.options.scheduleRules.normalize({
            cron: trigger.cron,
            ...(trigger.timezone !== undefined ? { timezone: trigger.timezone } : {}),
            now,
          });
          if (!definition) throw invalidSchedule("Workflow");
          const previous = currentTriggers.get(trigger.id);
          const publicTrigger: WorkflowAutomationTrigger = {
            id: trigger.id,
            type: "schedule",
            cron: definition.cron,
            timezone: definition.timezone,
            prompt: trigger.prompt?.trim() || "Run this workflow.",
            enabled: trigger.enabled !== false,
            lastRunAt: previous?.type === "schedule" ? previous.lastRunAt : null,
            nextRunAt: trigger.enabled === false ? null : definition.nextRunAt,
          };
          const execution =
            publicTrigger.enabled && normalized.status === "active"
              ? validatedExecution(
                  await this.options.planner.prepareWorkflow({
                    actor,
                    workflow: {
                      ...current,
                      ...normalizedDefinition,
                      scope,
                      trigger: workflowTriggerWithoutId(publicTrigger),
                    },
                    prompt: publicTrigger.prompt,
                  }),
                )
              : undefined;
          return {
            trigger: publicTrigger,
            userWorkosId: actor.userId,
            activatedAt: now,
            ...(execution ? { execution } : {}),
          };
        }),
      );
      const result = await this.repository.updateWorkflow({
        actor,
        workflowId: id,
        expectedVersion,
        scope,
        slackChannel,
        ...normalized,
        trigger: legacyTriggerFromAutomation(automationTriggers[0]?.trigger),
        automationTriggers,
        ...(automationTriggers[0]?.trigger.type === "schedule"
          ? {
              schedule: {
                definition: {
                  cron: automationTriggers[0].trigger.cron,
                  timezone: automationTriggers[0].trigger.timezone,
                  nextRunAt:
                    automationTriggers[0].trigger.nextRunAt ??
                    this.options.scheduleRules.normalize({
                      cron: automationTriggers[0].trigger.cron,
                      timezone: automationTriggers[0].trigger.timezone,
                      now,
                    })!.nextRunAt,
                },
                ...(automationTriggers[0].execution
                  ? { execution: automationTriggers[0].execution }
                  : {}),
              },
            }
          : automationTriggers[0]?.trigger.type === "event"
            ? {
                event: automationTriggers[0].execution
                  ? { execution: automationTriggers[0].execution }
                  : {},
              }
            : {}),
      });
      return workflowVersionResult(result);
    }
    let schedule:
      | { definition: ScheduleDefinition; execution?: AutomationExecutionPlan }
      | undefined;
    let event: { execution?: AutomationExecutionPlan } | undefined;
    if (normalized.trigger.type === "schedule") {
      const definition = this.options.scheduleRules.normalize({
        cron: normalized.trigger.cron,
        ...(normalized.trigger.timezone !== undefined
          ? { timezone: normalized.trigger.timezone }
          : {}),
        now,
      });
      if (!definition) throw invalidSchedule("Workflow");
      schedule = { definition };
      if (normalized.trigger.enabled !== false && normalized.status === "active") {
        const pending: Workflow = {
          ...current,
          ...normalizedDefinition,
          scope,
          trigger: {
            type: "schedule",
            cron: definition.cron,
            timezone: definition.timezone,
            prompt: normalized.trigger.prompt?.trim() || "Run this workflow.",
            enabled: true,
            lastRunAt: current.trigger.type === "schedule" ? current.trigger.lastRunAt : null,
            nextRunAt: definition.nextRunAt,
          },
        };
        schedule.execution = validatedExecution(
          await this.options.planner.prepareWorkflow({
            actor,
            workflow: pending,
            prompt: pending.trigger.type === "schedule" ? pending.trigger.prompt : pending.name,
          }),
        );
      }
    }
    if (normalized.trigger.type === "event") {
      const subscriptionError = await this.options.validateEventSubscription?.({
        actor,
        trigger: normalized.trigger,
      });
      if (subscriptionError) throw new CoreError("invalid_argument", subscriptionError);
      event = {};
      if (normalized.status === "active") {
        const pending: Workflow = {
          ...current,
          ...normalizedDefinition,
          scope,
          trigger: normalized.trigger,
        };
        event.execution = validatedExecution(
          await this.options.planner.prepareWorkflow({
            actor,
            workflow: pending,
            prompt: normalized.trigger.prompt,
          }),
        );
      }
    }
    const result = await this.repository.updateWorkflow({
      actor,
      workflowId: id,
      expectedVersion,
      scope,
      slackChannel,
      ...normalized,
      ...(schedule ? { schedule } : {}),
      ...(event ? { event } : {}),
    });
    return workflowVersionResult(result);
  }

  async getWorkflowMemory(actor: Actor, workflowId: string): Promise<WorkflowMemory> {
    requirePermission(actor, WORKFLOW_READ_PERMISSION, "Workflows");
    const memory = await this.repository.getWorkflowMemory({
      actor,
      workflowId: resourceId(workflowId, "workflowId"),
    });
    if (!memory) throw new CoreError("not_found", "Workflow not found.");
    return memory;
  }

  // Memory is deliberately not part of the versioned definition: toggling it takes effect on the
  // next run without bumping the workflow version or re-planning its triggers.
  async setWorkflowMemoryEnabled(
    actor: Actor,
    workflowId: string,
    enabled: boolean,
  ): Promise<WorkflowMemory> {
    requirePermission(actor, WORKFLOW_WRITE_PERMISSION, "Workflows");
    const memory = await this.repository.setWorkflowMemoryEnabled({
      actor,
      workflowId: resourceId(workflowId, "workflowId"),
      enabled,
    });
    if (!memory) throw new CoreError("not_found", "Workflow not found.");
    return memory;
  }

  async clearWorkflowMemory(actor: Actor, workflowId: string): Promise<WorkflowMemory> {
    requirePermission(actor, WORKFLOW_WRITE_PERMISSION, "Workflows");
    const memory = await this.repository.clearWorkflowMemory({
      actor,
      workflowId: resourceId(workflowId, "workflowId"),
    });
    if (!memory) throw new CoreError("not_found", "Workflow not found.");
    return memory;
  }

  async archiveWorkflow(
    actor: Actor,
    workflowId: string,
    expectedVersion: number,
  ): Promise<WorkflowArchiveResult> {
    requirePermission(actor, WORKFLOW_WRITE_PERMISSION, "Workflows");
    const result = await this.repository.archiveWorkflow({
      actor,
      workflowId: resourceId(workflowId, "workflowId"),
      expectedVersion: version(expectedVersion),
    });
    if (result.status === "not_found") throw new CoreError("not_found", "Workflow not found.");
    if (result.status === "conflict") throw versionConflict("Workflow");
    return {
      workflowId: result.value.workflowId,
      version: result.value.version,
      transactionId: result.transactionId,
    };
  }

  async invokeWorkflow(
    actor: Actor,
    workflowId: string,
    input: {
      idempotencyKey: string;
      description: string;
      attachmentIds?: readonly string[];
      skillIds?: readonly string[];
      stepModelOverrides?: readonly Pick<
        WorkflowStep,
        "id" | "model" | "runtimeModel" | "reasoningEffort"
      >[];
    },
  ): Promise<CreateTaskResult> {
    requirePermission(actor, WORKFLOW_WRITE_PERMISSION, "Workflows");
    const workflow = await this.runnableWorkflow(actor, workflowId);
    const goal = prompt(input.description, "A Workflow task description is required.");
    const execution = validatedExecution(
      await this.options.planner.prepareWorkflow({
        actor,
        workflow: workflowWithModelOverrides(workflow, input.stepModelOverrides),
        prompt: goal,
        ...(input.skillIds?.length ? { skillIds: workflowSkillIds(input.skillIds) } : {}),
      }),
    );
    return this.options.taskCreator.create({
      actor,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      name: workflow.name,
      goal,
      execution,
      source: "workflow",
      workflowId: workflow.slug,
      ...(input.attachmentIds ? { attachmentIds: input.attachmentIds } : {}),
    });
  }

  async runWorkflowNow(
    actor: Actor,
    workflowId: string,
    idempotencyKeyValue: string,
  ): Promise<CreateTaskResult> {
    requirePermission(actor, WORKFLOW_WRITE_PERMISSION, "Workflows");
    const workflow = await this.repository.getWorkflow({
      actor,
      workflowId: resourceId(workflowId, "workflowId"),
    });
    if (!workflow) throw new CoreError("not_found", "Workflow not found.");
    if (workflow.steps.length === 0 || workflow.steps.some((step) => !step.instructions.trim())) {
      throw new CoreError("invalid_argument", "Workflow is unavailable or incomplete.");
    }
    const trigger = workflow.triggers?.[0] ?? workflow.trigger;
    const triggerPrompt = trigger.type === "manual" ? "" : trigger.prompt.trim();
    const goal = prompt(
      !triggerPrompt || triggerPrompt === DEFAULT_WORKFLOW_SCHEDULE_PROMPT
        ? workflow.steps[0]!.instructions
        : triggerPrompt,
      "A Workflow prompt is required.",
    );
    const execution = validatedExecution(
      await this.options.planner.prepareWorkflow({ actor, workflow, prompt: goal }),
    );
    const created = await this.options.taskCreator.create({
      actor,
      idempotencyKey: idempotencyKey(idempotencyKeyValue),
      name: workflow.name,
      goal,
      execution,
      source: "workflow",
      workflowId: workflow.slug,
    });
    return created;
  }

  private async runnableWorkflow(actor: Actor, workflowId: string) {
    const workflow = await this.repository.getWorkflow({
      actor,
      workflowId: resourceId(workflowId, "workflowId"),
    });
    if (!workflow) throw new CoreError("not_found", "Workflow not found.");
    if (
      workflow.status !== "active" ||
      workflow.steps.length === 0 ||
      workflow.steps.some((step) => !step.instructions.trim())
    ) {
      throw new CoreError("invalid_argument", "Workflow is unavailable or incomplete.");
    }
    return workflow;
  }
}

export class TaskScheduleApplicationService {
  constructor(
    private readonly repository: TaskScheduleRepository,
    private readonly options: TaskScheduleApplicationServiceOptions,
  ) {}

  listTaskSchedules(
    actor: Actor,
    input: { cursor?: string; limit?: number } = {},
  ): Promise<TaskSchedulePage> {
    requirePermission(actor, SCHEDULE_READ_PERMISSION, "Schedules");
    return this.repository.listTaskSchedules({
      actor,
      ...(input.cursor ? { cursor: resourceId(input.cursor, "cursor") } : {}),
      limit: Math.max(1, Math.min(input.limit ?? 50, 100)),
    });
  }

  async getTaskSchedule(actor: Actor, scheduleId: string): Promise<TaskSchedule> {
    requirePermission(actor, SCHEDULE_READ_PERMISSION, "Schedules");
    const schedule = await this.repository.getTaskSchedule({
      actor,
      scheduleId: resourceId(scheduleId, "scheduleId"),
    });
    if (!schedule) throw new CoreError("not_found", "Recurring Task not found.");
    return schedule;
  }

  async createTaskSchedule(
    actor: Actor,
    input: {
      idempotencyKey: string;
      name?: string;
      sourceDescription?: string;
      cron: string;
      timezone?: string | null;
      prompt: string;
    },
  ): Promise<TaskScheduleMutationResult> {
    requirePermission(actor, SCHEDULE_WRITE_PERMISSION, "Schedules");
    const now = this.options.now?.() ?? new Date();
    const normalizedPrompt = prompt(input.prompt, "Recurring Task prompt is required.");
    const schedule = this.options.scheduleRules.normalize({
      cron: input.cron,
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      now,
    });
    if (!schedule) throw invalidSchedule("Recurring Task");
    const createInput = {
      actor,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      name: scheduleName(input.name, normalizedPrompt),
      sourceDescription: sourceDescription(input.sourceDescription ?? ""),
      prompt: normalizedPrompt,
      schedule,
    };
    const replay = await this.repository.replayTaskScheduleCreate(createInput);
    if (replay) return replay;
    await this.repository.assertTaskScheduleWriteAllowed(actor);
    const execution = validatedExecution(
      await this.options.planner.prepareTaskSchedule({ actor, prompt: normalizedPrompt }),
    );
    return this.repository.createTaskSchedule({
      ...createInput,
      execution,
    });
  }

  async updateTaskSchedule(
    actor: Actor,
    scheduleId: string,
    input: {
      expectedVersion: number;
      name: string;
      sourceDescription?: string;
      cron: string;
      timezone?: string | null;
      prompt: string;
    },
  ): Promise<TaskScheduleVersionResult> {
    requirePermission(actor, SCHEDULE_WRITE_PERMISSION, "Schedules");
    await this.repository.assertTaskScheduleWriteAllowed(actor);
    const id = resourceId(scheduleId, "scheduleId");
    const expectedVersion = version(input.expectedVersion);
    const current = await this.repository.getTaskSchedule({ actor, scheduleId: id });
    if (!current) throw new CoreError("not_found", "Recurring Task not found.");
    if (current.version !== expectedVersion) throw versionConflict("Recurring Task");
    const now = this.options.now?.() ?? new Date();
    const normalizedPrompt = prompt(input.prompt, "Recurring Task prompt is required.");
    const schedule = this.options.scheduleRules.normalize({
      cron: input.cron,
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      now,
    });
    if (!schedule) throw invalidSchedule("Recurring Task");
    const execution = validatedExecution(
      await this.options.planner.prepareTaskSchedule({ actor, prompt: normalizedPrompt }),
    );
    const result = await this.repository.updateTaskSchedule({
      actor,
      scheduleId: id,
      expectedVersion,
      name: scheduleName(input.name, normalizedPrompt),
      sourceDescription: sourceDescription(input.sourceDescription ?? ""),
      prompt: normalizedPrompt,
      schedule,
      execution,
    });
    return taskScheduleVersionResult(result);
  }

  async setTaskScheduleEnabled(
    actor: Actor,
    scheduleId: string,
    input: { expectedVersion: number; enabled: boolean },
  ): Promise<TaskScheduleVersionResult> {
    requirePermission(actor, SCHEDULE_WRITE_PERMISSION, "Schedules");
    await this.repository.assertTaskScheduleWriteAllowed(actor);
    const id = resourceId(scheduleId, "scheduleId");
    const expectedVersion = version(input.expectedVersion);
    let nextRunAt: Date | undefined;
    if (input.enabled) {
      const current = await this.repository.getTaskSchedule({ actor, scheduleId: id });
      if (!current) throw new CoreError("not_found", "Recurring Task not found.");
      if (current.version !== expectedVersion) throw versionConflict("Recurring Task");
      const schedule = this.options.scheduleRules.normalize({
        cron: current.cron,
        timezone: current.timezone,
        now: this.options.now?.() ?? new Date(),
      });
      if (!schedule) throw invalidSchedule("Recurring Task");
      nextRunAt = schedule.nextRunAt;
    }
    const result = await this.repository.setTaskScheduleEnabled({
      actor,
      scheduleId: id,
      expectedVersion,
      enabled: input.enabled,
      ...(nextRunAt ? { nextRunAt } : {}),
    });
    return taskScheduleVersionResult(result);
  }

  async archiveTaskSchedule(
    actor: Actor,
    scheduleId: string,
    expectedVersion: number,
  ): Promise<TaskScheduleArchiveResult> {
    requirePermission(actor, SCHEDULE_WRITE_PERMISSION, "Schedules");
    await this.repository.assertTaskScheduleWriteAllowed(actor);
    const result = await this.repository.archiveTaskSchedule({
      actor,
      scheduleId: resourceId(scheduleId, "scheduleId"),
      expectedVersion: version(expectedVersion),
    });
    if (result.status === "not_found") {
      throw new CoreError("not_found", "Recurring Task not found.");
    }
    if (result.status === "conflict") throw versionConflict("Recurring Task");
    return {
      scheduleId: result.value.scheduleId,
      version: result.value.version,
      transactionId: result.transactionId,
    };
  }

  async runTaskScheduleNow(
    actor: Actor,
    scheduleId: string,
    idempotencyKeyValue: string,
  ): Promise<CreateTaskResult> {
    requirePermission(actor, SCHEDULE_WRITE_PERMISSION, "Schedules");
    await this.repository.assertTaskScheduleWriteAllowed(actor);
    const id = resourceId(scheduleId, "scheduleId");
    const loaded = await this.repository.loadTaskScheduleExecution({ actor, scheduleId: id });
    if (!loaded) throw new CoreError("not_found", "Recurring Task not found.");
    const created = await this.options.taskCreator.create({
      actor,
      idempotencyKey: idempotencyKey(idempotencyKeyValue),
      name: loaded.schedule.name,
      goal: loaded.schedule.prompt,
      execution: validatedExecution(loaded.execution),
      source: "schedule",
      scheduleId: loaded.schedule.id,
    });
    await this.repository.recordRunNow({
      actor,
      scheduleId: loaded.schedule.id,
      taskId: created.task.id,
      occurredAt: created.task.createdAt,
    });
    return created;
  }
}

function normalizeWorkflowDefinition(
  input: {
    name: string;
    description: string;
    steps: WorkflowStep[];
    status: WorkflowStatus;
    trigger: WorkflowTriggerInput;
    triggers?: WorkflowAutomationTriggerInput[];
  },
  validator?: WorkflowDefinitionValidator,
) {
  const normalized = {
    name: workflowName(input.name),
    description: workflowDescription(input.description),
    steps: workflowSteps(input.steps),
    status: workflowStatus(input.status),
    trigger: workflowTrigger(input.trigger),
    ...(input.triggers ? { triggers: workflowAutomationTriggers(input.triggers) } : {}),
  };
  validateWorkflowDefinition(normalized, validator);
  return normalized;
}

function validateWorkflowDefinition(
  input: {
    name: string;
    description: string;
    steps: WorkflowStep[];
    status: WorkflowStatus;
    trigger: WorkflowTriggerInput;
  },
  validator?: WorkflowDefinitionValidator,
) {
  if (input.steps.length === 0 || input.steps.length > MAX_WORKFLOW_STEPS) {
    throw new CoreError("invalid_argument", "Workflows need between one and twenty steps.");
  }
  const ids = new Set<string>();
  for (const step of input.steps) {
    if (ids.has(step.id)) {
      throw new CoreError("invalid_argument", "Workflow step IDs must be unique.");
    }
    ids.add(step.id);
  }
  const providerError = validator?.(input);
  if (providerError) throw new CoreError("invalid_argument", providerError);
}

function workflowAutomationTriggers(
  triggers: WorkflowAutomationTriggerInput[],
): WorkflowAutomationTriggerInput[] {
  if (triggers.length > 20) {
    throw new CoreError("invalid_argument", "Workflows support at most twenty triggers.");
  }
  const ids = new Set<string>();
  return triggers.map((trigger, index) => {
    const id = resourceId(trigger.id, `triggers[${index}].id`);
    if (ids.has(id))
      throw new CoreError("invalid_argument", "Workflow trigger IDs must be unique.");
    ids.add(id);
    const normalized = workflowTrigger(trigger);
    if (normalized.type === "manual") {
      throw new CoreError("invalid_argument", "Manual runs do not need a workflow trigger.");
    }
    return { ...normalized, id };
  });
}

function legacyTriggerFromAutomation(
  trigger: WorkflowAutomationTrigger | undefined,
): WorkflowTriggerInput {
  if (!trigger) return { type: "manual" };
  if (trigger.type === "schedule") {
    return {
      type: "schedule",
      cron: trigger.cron,
      timezone: trigger.timezone,
      prompt: trigger.prompt,
      enabled: trigger.enabled,
    };
  }
  return {
    type: "event",
    provider: trigger.provider,
    event: trigger.event,
    integrationId: trigger.integrationId,
    filters: trigger.filters,
    prompt: trigger.prompt,
  };
}

function workflowTriggerWithoutId(trigger: WorkflowAutomationTrigger): WorkflowTrigger {
  if (trigger.type === "event") {
    return {
      type: "event",
      provider: trigger.provider,
      event: trigger.event,
      integrationId: trigger.integrationId,
      filters: trigger.filters,
      prompt: trigger.prompt,
    };
  }
  return {
    type: "schedule",
    cron: trigger.cron,
    timezone: trigger.timezone,
    prompt: trigger.prompt,
    enabled: trigger.enabled,
    lastRunAt: trigger.lastRunAt,
    nextRunAt: trigger.nextRunAt,
  };
}

function automationTriggersFromLegacyUpdate(
  current: Workflow,
  trigger: WorkflowTriggerInput,
): WorkflowAutomationTriggerInput[] {
  if (trigger.type === "manual") return [];
  const currentTriggers = current.triggers ?? [];
  const firstId = currentTriggers[0]?.id ?? `trigger-${current.id}`;
  return [
    { id: firstId, ...trigger },
    ...currentTriggers.slice(1).map(workflowAutomationTriggerInput),
  ];
}

function workflowAutomationTriggerInput(
  trigger: WorkflowAutomationTrigger,
): WorkflowAutomationTriggerInput {
  if (trigger.type === "event") return { ...trigger };
  return {
    id: trigger.id,
    type: "schedule",
    cron: trigger.cron,
    timezone: trigger.timezone,
    prompt: trigger.prompt,
    enabled: trigger.enabled,
  };
}

function workflowSteps(steps: WorkflowStep[]) {
  return steps.map((step) => {
    const id = bounded(step.id, MAX_STEP_ID_LENGTH, "Workflow step ID");
    const title = boundedOptional(step.title, MAX_STEP_TITLE_LENGTH, "Workflow step title");
    const model = boundedOptional(step.model, MAX_STEP_MODEL_LENGTH, "Workflow step model");
    const instructions = boundedOptional(
      step.instructions,
      MAX_STEP_INSTRUCTIONS_LENGTH,
      "Workflow step instructions",
    );
    const runtimeModel = step.runtimeModel?.trim();
    const reasoningEffort = step.reasoningEffort?.trim();
    return {
      id,
      title,
      model,
      instructions,
      ...(runtimeModel
        ? { runtimeModel: bounded(runtimeModel, 256, "Workflow runtime model") }
        : {}),
      ...(reasoningEffort
        ? { reasoningEffort: bounded(reasoningEffort, 64, "Workflow reasoning effort") }
        : {}),
    };
  });
}

function workflowTrigger(trigger: WorkflowTriggerInput): NormalizedWorkflowTriggerInput {
  if (trigger.type === "manual") return { type: "manual" };
  if (trigger.type === "event") {
    const provider = bounded(trigger.provider, 64, "Workflow event provider");
    const event = bounded(trigger.event, 128, "Workflow event");
    if (
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(provider) ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(event)
    ) {
      throw new CoreError("invalid_argument", "Workflow event trigger is invalid.");
    }
    return {
      type: "event",
      provider,
      event,
      integrationId: bounded(trigger.integrationId, 256, "Workflow integration ID"),
      filters: workflowEventFilters(trigger.filters),
      prompt:
        boundedOptional(
          trigger.prompt ?? "Handle this event.",
          MAX_PROMPT_LENGTH,
          "Workflow event prompt",
        ) || "Review and triage this Linear issue.",
    };
  }
  return {
    type: "schedule",
    cron: bounded(trigger.cron, 128, "Workflow schedule cron"),
    timezone:
      boundedOptional(trigger.timezone ?? "UTC", 128, "Workflow schedule timezone") || "UTC",
    prompt:
      boundedOptional(
        trigger.prompt ?? "Run this workflow.",
        MAX_PROMPT_LENGTH,
        "Workflow schedule prompt",
      ) || "Run this workflow.",
    enabled: trigger.enabled ?? true,
  };
}

function workflowEventFilters(filters: Record<string, WorkflowEventFilterValue>) {
  const entries = Object.entries(filters);
  if (entries.length > 16) {
    throw new CoreError("invalid_argument", "Workflow event triggers support at most 16 filters.");
  }
  return Object.fromEntries(
    entries.map(([rawId, value]) => {
      const id = bounded(rawId, 64, "Workflow event filter ID");
      if (!/^[a-z][a-z0-9_]*$/u.test(id)) {
        throw new CoreError("invalid_argument", "Workflow event filter ID is invalid.");
      }
      const key = value.key?.trim();
      const metadataEntries = Object.entries(value.metadata ?? {});
      if (metadataEntries.length > 16) {
        throw new CoreError("invalid_argument", "Workflow event filter metadata is too large.");
      }
      return [
        id,
        {
          id: bounded(value.id, 256, "Workflow event filter value"),
          name: bounded(value.name, 256, "Workflow event filter name"),
          ...(key ? { key: bounded(key, 64, "Workflow event filter key") } : {}),
          ...(metadataEntries.length
            ? {
                metadata: Object.fromEntries(
                  metadataEntries.map(([metadataKey, metadataValue]) => [
                    bounded(metadataKey, 64, "Workflow event filter metadata key"),
                    bounded(metadataValue, 256, "Workflow event filter metadata value"),
                  ]),
                ),
              }
            : {}),
        },
      ];
    }),
  );
}

function workflowStatus(status: WorkflowStatus) {
  if (!WORKFLOW_STATUSES.includes(status)) {
    throw new CoreError("invalid_argument", "Workflow status is invalid.");
  }
  return status;
}

function workflowName(value: string) {
  return bounded(value, MAX_WORKFLOW_NAME_LENGTH, "Workflow name");
}

function workflowSlackChannel(value: WorkflowSlackChannel): WorkflowSlackChannel {
  if (typeof value.enabled !== "boolean") {
    throw new CoreError("invalid_argument", "Provide whether the Slack channel is enabled.");
  }
  const displayName = value.displayName.trim();
  if (displayName.length > MAX_SLACK_DISPLAY_NAME_LENGTH) {
    throw new CoreError(
      "invalid_argument",
      `The Slack display name must be ${MAX_SLACK_DISPLAY_NAME_LENGTH} characters or fewer.`,
    );
  }
  const avatarUrl = value.avatarUrl.trim();
  if (avatarUrl.length > MAX_SLACK_AVATAR_URL_LENGTH) {
    throw new CoreError(
      "invalid_argument",
      `The Slack avatar URL must be ${MAX_SLACK_AVATAR_URL_LENGTH} characters or fewer.`,
    );
  }
  if (avatarUrl) {
    let parsed: URL;
    try {
      parsed = new URL(avatarUrl);
    } catch {
      throw new CoreError("invalid_argument", "The Slack avatar must be a valid HTTPS URL.");
    }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
      throw new CoreError("invalid_argument", "The Slack avatar must be a valid HTTPS URL.");
    }
  }
  return { enabled: value.enabled, displayName, avatarUrl };
}

function workflowScope(value: WorkflowScope): WorkflowScope {
  if (!WORKFLOW_SCOPES.includes(value)) {
    throw new CoreError("invalid_argument", "Workflow visibility must be personal or company.");
  }
  return value;
}

function workflowDescription(value: string) {
  const description = boundedOptional(
    value,
    MAX_WORKFLOW_DESCRIPTION_LENGTH,
    "Workflow description",
  );
  if (description.includes("<") || description.includes(">")) {
    throw new CoreError("invalid_argument", 'Workflow descriptions cannot contain "<" or ">".');
  }
  return description;
}

function scheduleName(value: string | undefined, schedulePrompt: string) {
  const source = value?.trim() || schedulePrompt.split(/\s+/u).slice(0, 7).join(" ");
  const normalized = source.replace(/\s+/gu, " ").trim() || "Recurring Task";
  return normalized.length > MAX_SCHEDULE_NAME_LENGTH
    ? `${normalized.slice(0, MAX_SCHEDULE_NAME_LENGTH - 3)}...`
    : normalized;
}

function sourceDescription(value: string) {
  return boundedOptional(value, MAX_SOURCE_DESCRIPTION_LENGTH, "Schedule source description");
}

function prompt(value: string, emptyMessage: string) {
  const normalized = value.trim();
  if (!normalized) throw new CoreError("invalid_argument", emptyMessage);
  if (normalized.length > MAX_PROMPT_LENGTH) {
    throw new CoreError("invalid_argument", "Prompts cannot exceed 10,000 characters.");
  }
  return normalized;
}

function validatedExecution(plan: AutomationExecutionPlan) {
  if (!CHAT_ENGINES.includes(plan.engine)) {
    throw new CoreError("invalid_argument", "Automation execution engine is invalid.");
  }
  const model = bounded(plan.model, 256, "Automation execution model");
  return { ...plan, model };
}

function workflowVersionResult(result: VersionedRepositoryResult<Workflow>): WorkflowVersionResult {
  if (result.status === "not_found") throw new CoreError("not_found", "Workflow not found.");
  if (result.status === "conflict") throw versionConflict("Workflow");
  return { workflow: result.value, transactionId: result.transactionId };
}

function taskScheduleVersionResult(
  result: VersionedRepositoryResult<TaskSchedule>,
): TaskScheduleVersionResult {
  if (result.status === "not_found") {
    throw new CoreError("not_found", "Recurring Task not found.");
  }
  if (result.status === "conflict") throw versionConflict("Recurring Task");
  return { schedule: result.value, transactionId: result.transactionId };
}

function versionConflict(resource: string) {
  return new CoreError("conflict", `${resource} changed since it was loaded.`);
}

function invalidSchedule(resource: string) {
  return new CoreError(
    "invalid_argument",
    `${resource} schedule must be a valid 5-field cron expression.`,
  );
}

function idempotencyKey(value: string) {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    /[^\x21-\x7e]/u.test(normalized)
  ) {
    throw new CoreError("invalid_argument", "A valid Idempotency-Key is required.");
  }
  return normalized;
}

function version(value: number) {
  if (!Number.isInteger(value) || value < 1) {
    throw new CoreError("invalid_argument", "expectedVersion must be a positive integer.");
  }
  return value;
}

function resourceId(value: string, field: string) {
  return bounded(value, MAX_RESOURCE_ID_LENGTH, field);
}

function workflowSkillIds(values: readonly string[]) {
  const normalized = [
    ...new Set(values.map((value, index) => resourceId(value, `skillIds[${index}]`))),
  ];
  if (normalized.length > MAX_WORKFLOW_SKILLS) {
    throw new CoreError(
      "invalid_argument",
      `skillIds must contain at most ${MAX_WORKFLOW_SKILLS} values.`,
    );
  }
  return normalized;
}

function bounded(value: string, max: number, field: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new CoreError("invalid_argument", `${field} is invalid.`);
  }
  return normalized;
}

function boundedOptional(value: string, max: number, field: string) {
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new CoreError("invalid_argument", `${field} is invalid.`);
  }
  return normalized;
}

function requirePermission(actor: Actor, permission: string, resource: string) {
  if (!actor.userId.trim() || !actor.workspaceId.trim() || !actorHasPermission(actor, permission)) {
    throw new CoreError("forbidden", `The actor is not allowed to access ${resource}.`);
  }
}

function workflowWithModelOverrides(
  workflow: Workflow,
  overrides: readonly Pick<
    WorkflowStep,
    "id" | "model" | "runtimeModel" | "reasoningEffort"
  >[] = [],
): Workflow {
  if (overrides.length > 20)
    throw new CoreError("invalid_argument", "Too many workflow model overrides.");
  const byId = new Map<string, WorkflowStep>();
  for (const override of overrides) {
    const step = workflow.steps.find((step) => step.id === override.id);
    if (!step || byId.has(override.id)) {
      throw new CoreError(
        "invalid_argument",
        "Workflow model overrides must reference distinct existing steps.",
      );
    }
    const [normalized] = workflowSteps([
      {
        id: step.id,
        title: step.title,
        instructions: step.instructions,
        model: override.model,
        ...(override.runtimeModel ? { runtimeModel: override.runtimeModel } : {}),
        ...(override.reasoningEffort ? { reasoningEffort: override.reasoningEffort } : {}),
      },
    ]);
    if (normalized) {
      byId.set(step.id, { ...normalized, title: step.title, instructions: step.instructions });
    }
  }
  return { ...workflow, steps: workflow.steps.map((step) => byId.get(step.id) ?? step) };
}
