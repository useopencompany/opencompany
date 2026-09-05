import { describe, expect, it, vi } from "vitest";
import {
  type Actor,
  SCHEDULE_READ_PERMISSION,
  SCHEDULE_WRITE_PERMISSION,
  WORKFLOW_READ_PERMISSION,
  WORKFLOW_WRITE_PERMISSION,
} from "./actor";
import { CoreError } from "./chat";
import type { CreateTaskResult } from "./tasks";
import {
  type AutomationExecutionPlanner,
  type AutomationTaskCreator,
  type ScheduleRules,
  type TaskSchedule,
  TaskScheduleApplicationService,
  type TaskScheduleRepository,
  type Workflow,
  WorkflowApplicationService,
  type WorkflowRepository,
} from "./workflows";

const now = new Date("2026-08-12T08:00:00.000Z");
const nextRunAt = new Date("2026-08-13T09:00:00.000Z");

describe("WorkflowApplicationService", () => {
  it("preserves the existing create shape while enforcing permissions and idempotency input", async () => {
    const repository = fakeWorkflowRepository();
    const service = workflowService(repository);

    await expect(
      service.createWorkflow(actor(), {
        idempotencyKey: " create-workflow-1 ",
        name: "  Weekly research  ",
        description: "  Market changes  ",
      }),
    ).resolves.toMatchObject({ workflow: { id: "workflow_1" } });
    expect(repository.createWorkflow).toHaveBeenCalledWith({
      actor: actor(),
      idempotencyKey: "create-workflow-1",
      name: "Weekly research",
      description: "Market changes",
      initialStep: {
        id: "step_new",
        title: "",
        model: "",
        instructions: "",
      },
    });

    expect(() =>
      service.createWorkflow(actor({ permissions: [WORKFLOW_READ_PERMISSION] }), {
        idempotencyKey: "create-workflow-2",
        name: "Denied",
      }),
    ).toThrow(/not allowed/i);
    expect(() =>
      service.createWorkflow(actor(), {
        idempotencyKey: "contains a space",
        name: "Invalid",
      }),
    ).toThrow(/Idempotency-Key/i);
  });

  it("normalizes scheduled updates and plans execution before the versioned write", async () => {
    const repository = fakeWorkflowRepository();
    const planner = fakePlanner();
    const service = workflowService(repository, { planner });

    await expect(
      service.updateWorkflow(actor(), " workflow_1 ", {
        expectedVersion: 1,
        name: "  Weekly research  ",
        description: "  Research changes  ",
        steps: [
          {
            id: " step_1 ",
            title: "  Find updates  ",
            model: " provider/model ",
            instructions: "  Find material updates.  ",
          },
        ],
        status: "active",
        trigger: {
          type: "schedule",
          cron: " 0 9 * * 1 ",
          timezone: " Europe/Berlin ",
          prompt: "  Run weekly research.  ",
        },
      }),
    ).resolves.toMatchObject({ workflow: { version: 2 }, transactionId: "43" });

    expect(planner.prepareWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: actor(),
        prompt: "Run weekly research.",
        workflow: expect.objectContaining({
          name: "Weekly research",
          steps: [
            {
              id: "step_1",
              title: "Find updates",
              model: "provider/model",
              instructions: "Find material updates.",
            },
          ],
          trigger: expect.objectContaining({
            type: "schedule",
            cron: "0 9 * * 1",
            timezone: "Europe/Berlin",
            nextRunAt,
          }),
        }),
      }),
    );
    expect(repository.updateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: actor(),
        workflowId: "workflow_1",
        expectedVersion: 1,
        schedule: {
          definition: { cron: "0 9 * * 1", timezone: "Europe/Berlin", nextRunAt },
          execution: executionPlan(),
        },
      }),
    );
  });

  it("rejects stale or incomplete scheduled definitions before planning or persistence", async () => {
    const repository = fakeWorkflowRepository();
    const planner = fakePlanner();
    const service = workflowService(repository, { planner });

    await expect(
      service.updateWorkflow(actor(), "workflow_1", {
        expectedVersion: 7,
        name: "Research",
        description: "",
        steps: [workflow().steps[0]!],
        status: "active",
        trigger: { type: "manual" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      service.updateWorkflow(actor(), "workflow_1", {
        expectedVersion: 1,
        name: "Research",
        description: "",
        steps: [{ ...workflow().steps[0]!, instructions: " " }],
        status: "active",
        trigger: { type: "schedule", cron: "0 9 * * 1" },
      }),
    ).rejects.toThrow(/need instructions/i);
    expect(planner.prepareWorkflow).not.toHaveBeenCalled();
    expect(repository.updateWorkflow).not.toHaveBeenCalled();
  });

  it("plans a durable Linear event trigger before persisting it", async () => {
    const repository = fakeWorkflowRepository();
    const planner = fakePlanner();
    const service = workflowService(repository, { planner });
    const trigger = {
      type: "event" as const,
      provider: "linear" as const,
      event: "issue_enters_triage" as const,
      integrationId: "gint_linear_1",
      filters: {
        team: {
          id: "team_1",
          name: "Engineering",
          key: "ENG",
          metadata: { triageStateId: "state_triage_1" },
        },
      },
      prompt: "Assess impact and recommend an owner.",
    };

    await service.updateWorkflow(actor(), "workflow_1", {
      expectedVersion: 1,
      name: "Triage issues",
      description: "Review incoming issues",
      steps: [
        {
          id: "step_1",
          title: "Assess",
          model: "provider/model",
          instructions: "Assess the issue.",
        },
      ],
      status: "active",
      trigger,
    });

    expect(planner.prepareWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: actor(),
        prompt: trigger.prompt,
        workflow: expect.objectContaining({ trigger }),
      }),
    );
    expect(repository.updateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger,
        event: { execution: executionPlan() },
      }),
    );
  });

  it("rejects an event trigger that is not enabled by its installed plugin", async () => {
    const repository = fakeWorkflowRepository();
    const planner = fakePlanner();
    const validateEventSubscription = vi.fn(async () => "Enable this plugin event first.");
    const service = workflowService(repository, { planner, validateEventSubscription });

    await expect(
      service.updateWorkflow(actor(), "workflow_1", {
        expectedVersion: 1,
        name: "New issues",
        description: "Review incoming work",
        steps: [
          {
            id: "step_1",
            title: "Review",
            model: "provider/model",
            instructions: "Review the issue.",
          },
        ],
        status: "active",
        trigger: {
          type: "event",
          provider: "linear",
          event: "issue.created",
          integrationId: "gint_linear_1",
          filters: { team: { id: "team_1", name: "Engineering" } },
          prompt: "Review this issue.",
        },
      }),
    ).rejects.toThrow("Enable this plugin event first.");
    expect(validateEventSubscription).toHaveBeenCalledOnce();
    expect(planner.prepareWorkflow).not.toHaveBeenCalled();
    expect(repository.updateWorkflow).not.toHaveBeenCalled();
  });

  it("routes invoke and run-now through canonical Task creation", async () => {
    const scheduled = workflow({
      trigger: {
        type: "schedule",
        cron: "0 9 * * 1",
        timezone: "UTC",
        prompt: "Review the market.",
        enabled: true,
        lastRunAt: null,
        nextRunAt,
      },
    });
    const repository = fakeWorkflowRepository({ workflow: scheduled });
    const taskCreator = fakeTaskCreator();
    const planner = fakePlanner();
    const service = workflowService(repository, { planner, taskCreator });

    await service.invokeWorkflow(actor(), "weekly-research", {
      idempotencyKey: "invoke-1",
      description: "  Focus on competitors.  ",
      attachmentIds: ["attachment_1"],
      skillIds: [" market-research "],
    });
    await service.runWorkflowNow(actor(), "weekly-research", "run-now-1");

    expect(taskCreator.create).toHaveBeenNthCalledWith(1, {
      actor: actor(),
      idempotencyKey: "invoke-1",
      name: "Weekly research",
      goal: "Focus on competitors.",
      execution: executionPlan(),
      source: "workflow",
      workflowId: "weekly-research",
      attachmentIds: ["attachment_1"],
    });
    expect(planner.prepareWorkflow).toHaveBeenNthCalledWith(1, {
      actor: actor(),
      workflow: scheduled,
      prompt: "Focus on competitors.",
      skillIds: ["market-research"],
    });
    expect(taskCreator.create).toHaveBeenNthCalledWith(2, {
      actor: actor(),
      idempotencyKey: "run-now-1",
      name: "Weekly research",
      goal: "Review the market.",
      execution: executionPlan(),
      source: "schedule",
      workflowId: "weekly-research",
    });
    expect(repository.recordRunNow).toHaveBeenCalledWith({
      actor: actor(),
      workflowId: "workflow_1",
      taskId: "task_1",
      occurredAt: now,
    });
  });

  it("rejects more than sixteen distinct invocation skills before planning", async () => {
    const repository = fakeWorkflowRepository();
    const planner = fakePlanner();
    const service = workflowService(repository, { planner });

    await expect(
      service.invokeWorkflow(actor(), "weekly-research", {
        idempotencyKey: "invoke-too-many-skills",
        description: "Research the market.",
        skillIds: Array.from({ length: 17 }, (_, index) => `skill-${index + 1}`),
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(planner.prepareWorkflow).not.toHaveBeenCalled();
  });
});

describe("TaskScheduleApplicationService", () => {
  it("checks actor feature policy before calling the external planner", async () => {
    const repository = fakeTaskScheduleRepository();
    repository.assertTaskScheduleWriteAllowed.mockRejectedValue(
      new CoreError("forbidden", "Tasks & Workflows is disabled for this actor."),
    );
    const planner = fakePlanner();
    const service = scheduleService(repository, { planner });

    await expect(
      service.createTaskSchedule(actor(), {
        idempotencyKey: "schedule-1",
        cron: "0 9 * * 1",
        prompt: "Research market changes.",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(repository.replayTaskScheduleCreate).toHaveBeenCalledOnce();
    expect(planner.prepareTaskSchedule).not.toHaveBeenCalled();
    expect(repository.createTaskSchedule).not.toHaveBeenCalled();
  });

  it("checks actor feature policy before every recurring Task mutation", async () => {
    const repository = fakeTaskScheduleRepository();
    repository.assertTaskScheduleWriteAllowed.mockRejectedValue(
      new CoreError("forbidden", "Tasks & Workflows is disabled for this actor."),
    );
    const taskCreator = fakeTaskCreator();
    const planner = fakePlanner();
    const service = scheduleService(repository, { planner, taskCreator });
    const update = {
      expectedVersion: 1,
      name: "Weekly research",
      cron: "0 9 * * 1",
      prompt: "Research market changes.",
    };

    await expect(service.updateTaskSchedule(actor(), "schedule_1", update)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      service.setTaskScheduleEnabled(actor(), "schedule_1", {
        expectedVersion: 1,
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.archiveTaskSchedule(actor(), "schedule_1", 1)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      service.runTaskScheduleNow(actor(), "schedule_1", "run-schedule-1"),
    ).rejects.toMatchObject({ code: "forbidden" });

    expect(repository.getTaskSchedule).not.toHaveBeenCalled();
    expect(repository.updateTaskSchedule).not.toHaveBeenCalled();
    expect(repository.setTaskScheduleEnabled).not.toHaveBeenCalled();
    expect(repository.archiveTaskSchedule).not.toHaveBeenCalled();
    expect(repository.loadTaskScheduleExecution).not.toHaveBeenCalled();
    expect(planner.prepareTaskSchedule).not.toHaveBeenCalled();
    expect(taskCreator.create).not.toHaveBeenCalled();
  });

  it("normalizes, plans, and writes recurring Tasks under the authenticated Actor", async () => {
    const repository = fakeTaskScheduleRepository();
    const planner = fakePlanner();
    const service = scheduleService(repository, { planner });

    await service.createTaskSchedule(actor(), {
      idempotencyKey: " create-schedule-1 ",
      sourceDescription: "  Created from Tasks  ",
      cron: " 0 9 * * 1 ",
      timezone: " Europe/Berlin ",
      prompt: "  Research market changes every week.  ",
    });

    expect(repository.createTaskSchedule).toHaveBeenCalledWith({
      actor: actor(),
      idempotencyKey: "create-schedule-1",
      name: "Research market changes every week.",
      sourceDescription: "Created from Tasks",
      prompt: "Research market changes every week.",
      schedule: { cron: "0 9 * * 1", timezone: "Europe/Berlin", nextRunAt },
      execution: executionPlan(),
    });
  });

  it("replays a recurring Task create without calling the external planner", async () => {
    const repository = fakeTaskScheduleRepository();
    repository.replayTaskScheduleCreate.mockResolvedValue({
      schedule: taskSchedule(),
      transactionId: "42",
      idempotentReplay: true,
    });
    const planner = fakePlanner();
    const service = scheduleService(repository, { planner });

    await expect(
      service.createTaskSchedule(actor(), {
        idempotencyKey: "schedule-1",
        cron: "0 9 * * 1",
        prompt: "Research market changes.",
      }),
    ).resolves.toMatchObject({ idempotentReplay: true });
    expect(planner.prepareTaskSchedule).not.toHaveBeenCalled();
    expect(repository.createTaskSchedule).not.toHaveBeenCalled();
  });

  it("does not accidentally require read permission for an authorized schedule mutation", async () => {
    const repository = fakeTaskScheduleRepository();
    const service = scheduleService(repository);

    await expect(
      service.updateTaskSchedule(
        actor({ permissions: [SCHEDULE_WRITE_PERMISSION] }),
        "schedule_1",
        {
          expectedVersion: 1,
          name: "Weekly research",
          cron: "0 9 * * 1",
          prompt: "Research market changes.",
        },
      ),
    ).resolves.toMatchObject({ schedule: { version: 2 } });
  });

  it("runs only an actor-owned stored plan through canonical Task creation", async () => {
    const repository = fakeTaskScheduleRepository();
    const taskCreator = fakeTaskCreator();
    const service = scheduleService(repository, { taskCreator });

    await service.runTaskScheduleNow(actor(), " schedule_1 ", " run-schedule-1 ");

    expect(taskCreator.create).toHaveBeenCalledWith({
      actor: actor(),
      idempotencyKey: "run-schedule-1",
      name: "Weekly research",
      goal: "Research market changes.",
      execution: executionPlan(),
      source: "schedule",
      scheduleId: "schedule_1",
    });
    expect(repository.recordRunNow).toHaveBeenCalledWith({
      actor: actor(),
      scheduleId: "schedule_1",
      taskId: "task_1",
      occurredAt: now,
    });
  });
});

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_1",
    workspaceId: "workspace_1",
    role: "admin",
    permissions: [
      WORKFLOW_READ_PERMISSION,
      WORKFLOW_WRITE_PERMISSION,
      SCHEDULE_READ_PERMISSION,
      SCHEDULE_WRITE_PERMISSION,
    ],
    authenticationMethod: "session",
    ...overrides,
  };
}

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "workflow_1",
    slug: "weekly-research",
    name: "Weekly research",
    description: "Research changes",
    steps: [
      {
        id: "step_1",
        title: "Research",
        model: "provider/model",
        instructions: "Find material updates.",
      },
    ],
    status: "active",
    trigger: { type: "manual" },
    version: 1,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function taskSchedule(): TaskSchedule {
  return {
    id: "schedule_1",
    name: "Weekly research",
    sourceDescription: "Created from Tasks",
    cron: "0 9 * * 1",
    timezone: "UTC",
    prompt: "Research market changes.",
    enabled: true,
    lastRunAt: null,
    nextRunAt,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function executionPlan() {
  return {
    engine: "opencompany" as const,
    model: "provider/model",
    payload: { engine: "opencompany", model: "provider/model", prompt: "Research" },
  };
}

function taskResult(): CreateTaskResult {
  return {
    task: {
      id: "task_1",
      displayId: "TASK-1",
      name: "Weekly research",
      goal: "Research market changes.",
      conversationId: "conversation_1",
      status: "queued",
      source: "schedule",
      engine: "opencompany",
      model: "provider/model",
      workflowId: null,
      scheduleId: "schedule_1",
      scheduledFor: null,
      outcome: { result: null, error: null, reportedStatus: null, comment: null },
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    messageId: "message_1",
    assistantMessageId: "message_2",
    runId: "run_1",
    transactionId: "42",
    idempotentReplay: false,
  };
}

function fakePlanner(): AutomationExecutionPlanner & {
  prepareWorkflow: ReturnType<typeof vi.fn>;
  prepareTaskSchedule: ReturnType<typeof vi.fn>;
} {
  return {
    prepareWorkflow: vi.fn(async () => executionPlan()),
    prepareTaskSchedule: vi.fn(async () => executionPlan()),
  };
}

function fakeTaskCreator(): AutomationTaskCreator & { create: ReturnType<typeof vi.fn> } {
  return { create: vi.fn(async () => taskResult()) };
}

function scheduleRules(): ScheduleRules {
  return {
    normalize: ({ cron, timezone }) => ({
      cron: cron.trim(),
      timezone: timezone?.trim() || "UTC",
      nextRunAt,
    }),
  };
}

function workflowService(
  repository: ReturnType<typeof fakeWorkflowRepository>,
  overrides: {
    planner?: ReturnType<typeof fakePlanner>;
    taskCreator?: ReturnType<typeof fakeTaskCreator>;
    validateEventSubscription?: () => Promise<string | null>;
  } = {},
) {
  return new WorkflowApplicationService(repository, {
    scheduleRules: scheduleRules(),
    planner: overrides.planner ?? fakePlanner(),
    taskCreator: overrides.taskCreator ?? fakeTaskCreator(),
    now: () => now,
    newStepId: () => "step_new",
    ...(overrides.validateEventSubscription
      ? { validateEventSubscription: overrides.validateEventSubscription }
      : {}),
  });
}

function scheduleService(
  repository: ReturnType<typeof fakeTaskScheduleRepository>,
  overrides: {
    planner?: ReturnType<typeof fakePlanner>;
    taskCreator?: ReturnType<typeof fakeTaskCreator>;
  } = {},
) {
  return new TaskScheduleApplicationService(repository, {
    scheduleRules: scheduleRules(),
    planner: overrides.planner ?? fakePlanner(),
    taskCreator: overrides.taskCreator ?? fakeTaskCreator(),
    now: () => now,
  });
}

function fakeWorkflowRepository(options: { workflow?: Workflow } = {}): WorkflowRepository & {
  createWorkflow: ReturnType<typeof vi.fn>;
  updateWorkflow: ReturnType<typeof vi.fn>;
  recordRunNow: ReturnType<typeof vi.fn>;
} {
  const stored = options.workflow ?? workflow();
  return {
    listWorkflows: vi.fn(async () => ({ workflows: [stored], nextCursor: null })),
    getWorkflow: vi.fn(async ({ workflowId }) =>
      workflowId === stored.id || workflowId === stored.slug ? stored : null,
    ),
    createWorkflow: vi.fn(async () => ({
      workflow: stored,
      transactionId: "42",
      idempotentReplay: false,
    })),
    updateWorkflow: vi.fn(async () => ({
      status: "updated" as const,
      value: { ...stored, version: 2 },
      transactionId: "43",
    })),
    archiveWorkflow: vi.fn(async () => ({
      status: "updated" as const,
      value: { workflowId: stored.id, version: stored.version + 1 },
      transactionId: "44",
    })),
    recordRunNow: vi.fn(async () => undefined),
  };
}

function fakeTaskScheduleRepository(): TaskScheduleRepository & {
  assertTaskScheduleWriteAllowed: ReturnType<typeof vi.fn>;
  replayTaskScheduleCreate: ReturnType<typeof vi.fn>;
  createTaskSchedule: ReturnType<typeof vi.fn>;
  recordRunNow: ReturnType<typeof vi.fn>;
} {
  const stored = taskSchedule();
  return {
    assertTaskScheduleWriteAllowed: vi.fn(async () => undefined),
    replayTaskScheduleCreate: vi.fn(async () => null),
    listTaskSchedules: vi.fn(async () => ({ schedules: [stored], nextCursor: null })),
    getTaskSchedule: vi.fn(async ({ scheduleId }) => (scheduleId === stored.id ? stored : null)),
    createTaskSchedule: vi.fn(async () => ({
      schedule: stored,
      transactionId: "42",
      idempotentReplay: false,
    })),
    updateTaskSchedule: vi.fn(async () => ({
      status: "updated" as const,
      value: { ...stored, version: 2 },
      transactionId: "43",
    })),
    setTaskScheduleEnabled: vi.fn(async () => ({
      status: "updated" as const,
      value: { ...stored, enabled: false, version: 2 },
      transactionId: "44",
    })),
    archiveTaskSchedule: vi.fn(async () => ({
      status: "updated" as const,
      value: { scheduleId: stored.id, version: 2 },
      transactionId: "45",
    })),
    loadTaskScheduleExecution: vi.fn(async ({ scheduleId }) =>
      scheduleId === stored.id ? { schedule: stored, execution: executionPlan() } : null,
    ),
    recordRunNow: vi.fn(async () => undefined),
  };
}
