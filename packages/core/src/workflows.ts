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

export type WorkflowStep = {
  id: string;
  title: string;
  model: string;
  runtimeModel?: string;
  reasoningEffort?: string;
  instructions: string;
};

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
  trigger: WorkflowTrigger;
  version: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkflowPage = {
  workflows: Workflow[];
  nextCursor: string | null;
};

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
    trigger: WorkflowTriggerInput;
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

  createWorkflow(
    actor: Actor,
    input: { idempotencyKey: string; name: string; description?: string },
  ): Promise<WorkflowMutationResult> {
    requirePermission(actor, WORKFLOW_WRITE_PERMISSION, "Workflows");
    const name = workflowName(input.name);
    const description = workflowDescription(input.description ?? "");
    const initialStep: WorkflowStep = {
      id: resourceId(this.options.newStepId?.() ?? crypto.randomUUID(), "stepId"),
      title: "",
      model: "",
      instructions: "",
    };
    validateWorkflowDefinition(
      { name, description, steps: [initialStep], status: "active", trigger: { type: "manual" } },
      this.options.validateDefinition,
    );
    return this.repository.createWorkflow({
      actor,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      name,
      description,
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
      trigger: WorkflowTriggerInput;
    },
  ): Promise<WorkflowVersionResult> {
    requirePermission(actor, WORKFLOW_WRITE_PERMISSION, "Workflows");
    const id = resourceId(workflowId, "workflowId");
    const expectedVersion = version(input.expectedVersion);
    const current = await this.repository.getWorkflow({ actor, workflowId: id });
    if (!current) throw new CoreError("not_found", "Workflow not found.");
    if (current.version !== expectedVersion) throw versionConflict("Workflow");
    const normalized = normalizeWorkflowDefinition(input, this.options.validateDefinition);
    const now = this.options.now?.() ?? new Date();
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
        if (normalized.steps.some((step) => !step.instructions.trim())) {
          throw new CoreError(
            "invalid_argument",
            "Scheduled Workflows need instructions in every step.",
          );
        }
        const pending: Workflow = {
          ...current,
          ...normalized,
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
        if (normalized.steps.some((step) => !step.instructions.trim())) {
          throw new CoreError(
            "invalid_argument",
            "Event-triggered Workflows need instructions in every step.",
          );
        }
        const pending: Workflow = { ...current, ...normalized, trigger: normalized.trigger };
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
      ...normalized,
      ...(schedule ? { schedule } : {}),
      ...(event ? { event } : {}),
    });
    return workflowVersionResult(result);
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
    },
  ): Promise<CreateTaskResult> {
    requirePermission(actor, WORKFLOW_WRITE_PERMISSION, "Workflows");
    const workflow = await this.runnableWorkflow(actor, workflowId);
    const goal = prompt(input.description, "A Workflow task description is required.");
    const execution = validatedExecution(
      await this.options.planner.prepareWorkflow({
        actor,
        workflow,
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
    const workflow = await this.runnableWorkflow(actor, workflowId);
    if (workflow.trigger.type !== "schedule") {
      throw new CoreError("invalid_argument", "Workflow does not have a scheduled trigger.");
    }
    const goal = prompt(workflow.trigger.prompt || workflow.name, "A Workflow prompt is required.");
    const execution = validatedExecution(
      await this.options.planner.prepareWorkflow({ actor, workflow, prompt: goal }),
    );
    const created = await this.options.taskCreator.create({
      actor,
      idempotencyKey: idempotencyKey(idempotencyKeyValue),
      name: workflow.name,
      goal,
      execution,
      source: "schedule",
      workflowId: workflow.slug,
    });
    await this.repository.recordRunNow({
      actor,
      workflowId: workflow.id,
      taskId: created.task.id,
      occurredAt: created.task.createdAt,
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
  },
  validator?: WorkflowDefinitionValidator,
) {
  const normalized = {
    name: workflowName(input.name),
    description: workflowDescription(input.description),
    steps: workflowSteps(input.steps),
    status: workflowStatus(input.status),
    trigger: workflowTrigger(input.trigger),
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
