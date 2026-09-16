import { describe, expect, it, vi } from "vitest";
import { type Actor, WORKFLOW_READ_PERMISSION, WORKFLOW_WRITE_PERMISSION } from "./actor";
import { CoreError } from "./chat";
import type { CreateTaskResult } from "./tasks";
import {
  type AutomationExecutionPlanner,
  type AutomationTaskCreator,
  type ScheduleRules,
  type Workflow,
  WorkflowApplicationService,
  type WorkflowMemory,
  type WorkflowRepository,
} from "./workflows";

const now = new Date("2026-08-12T08:00:00.000Z");
const nextRunAt = new Date("2026-08-13T09:00:00.000Z");

describe("WorkflowApplicationService", () => {
  it("toggles and clears memory without a version check, and enforces workflow permissions", async () => {
    const repository = fakeWorkflowRepository();
    const service = workflowService(repository);

    await expect(service.getWorkflowMemory(actor(), "workflow_1")).resolves.toMatchObject({
      enabled: false,
      content: "Remembered from the last run.",
    });

    await expect(
      service.setWorkflowMemoryEnabled(actor(), "workflow_1", true),
    ).resolves.toMatchObject({ enabled: true });
    expect(repository.setWorkflowMemoryEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "workflow_1", enabled: true }),
    );

    await expect(service.clearWorkflowMemory(actor(), "workflow_1")).resolves.toMatchObject({
      content: "",
      updatedAt: null,
    });

    // Memory lives outside the versioned definition, so none of this rewrites the workflow.
    expect(repository.updateWorkflow).not.toHaveBeenCalled();

    await expect(
      service.setWorkflowMemoryEnabled(actor({ permissions: [] }), "workflow_1", true),
    ).rejects.toThrow("The actor is not allowed to access Workflows.");
  });

  it("reports a missing or invisible workflow when reading memory", async () => {
    const service = workflowService(fakeWorkflowRepository());
    await expect(service.getWorkflowMemory(actor(), "workflow_missing")).rejects.toThrow(
      "Workflow not found.",
    );
  });

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
      // A workflow is company-wide unless its author asks for a personal one.
      scope: "company",
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

  it("keeps the stored channel configuration when an update omits it and trims a new name", async () => {
    const repository = fakeWorkflowRepository();
    const service = workflowService(repository);
    const definition = {
      expectedVersion: 1,
      name: "Weekly research",
      description: "",
      steps: [workflow().steps[0]!],
      status: "draft" as const,
      trigger: { type: "manual" as const },
    };

    await service.updateWorkflow(actor(), "workflow_1", definition);
    expect(repository.updateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ slackChannel: { enabled: true, displayName: "", avatarUrl: "" } }),
    );

    await service.updateWorkflow(actor(), "workflow_1", {
      ...definition,
      slackChannel: {
        enabled: false,
        displayName: "  James  ",
        avatarUrl: "  https://example.com/james.png  ",
      },
    });
    expect(repository.updateWorkflow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        slackChannel: {
          enabled: false,
          displayName: "James",
          avatarUrl: "https://example.com/james.png",
        },
      }),
    );

    await expect(
      service.updateWorkflow(actor(), "workflow_1", {
        ...definition,
        slackChannel: { enabled: true, displayName: "J".repeat(81), avatarUrl: "" },
      }),
    ).rejects.toThrow("80 characters or fewer");

    await expect(
      service.updateWorkflow(actor(), "workflow_1", {
        ...definition,
        slackChannel: {
          enabled: true,
          displayName: "James",
          avatarUrl: "http://example.com/a.png",
        },
      }),
    ).rejects.toThrow("valid HTTPS URL");
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
    ).rejects.toThrow("Add instructions to step 1 before activating this workflow.");
    expect(planner.prepareWorkflow).not.toHaveBeenCalled();
    expect(repository.updateWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    { type: "manual" as const },
    { type: "schedule" as const, cron: "0 9 * * 1" },
    {
      type: "event" as const,
      provider: "linear",
      event: "issue.created",
      integrationId: "gint_1",
      filters: {},
      prompt: "Run this workflow.",
    },
  ])(
    "saves incomplete $type drafts but rejects activation without planning or persistence",
    async (trigger) => {
      const repository = fakeWorkflowRepository();
      const planner = fakePlanner();
      const service = workflowService(repository, { planner });
      const input = {
        expectedVersion: 1,
        name: "Research",
        description: "",
        steps: [
          workflow().steps[0]!,
          { ...workflow().steps[0]!, id: "step_empty", instructions: "  " },
        ],
        status: "draft" as const,
        trigger,
      };
      await service.updateWorkflow(actor(), "workflow_1", input);
      expect(repository.updateWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "draft",
          steps: [input.steps[0], expect.objectContaining({ instructions: "" })],
        }),
      );
      expect(planner.prepareWorkflow).not.toHaveBeenCalled();
      repository.updateWorkflow.mockClear();
      await expect(
        service.updateWorkflow(actor(), "workflow_1", { ...input, status: "active" }),
      ).rejects.toThrow("Add instructions to step 2 before activating this workflow.");
      expect(planner.prepareWorkflow).not.toHaveBeenCalled();
      expect(repository.updateWorkflow).not.toHaveBeenCalled();
    },
  );

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

  it("plans and persists every trigger in a multi-trigger workflow", async () => {
    const repository = fakeWorkflowRepository();
    const planner = fakePlanner();
    const service = workflowService(repository, { planner });
    const triggers = [
      {
        id: "trigger_schedule",
        type: "schedule" as const,
        cron: "0 9 * * 1",
        timezone: "UTC",
        prompt: "Run weekly.",
        enabled: true,
      },
      {
        id: "trigger_event",
        type: "event" as const,
        provider: "linear",
        event: "issue.created",
        integrationId: "gint_linear_1",
        filters: {},
        prompt: "Review the issue.",
      },
    ];

    await service.updateWorkflow(actor(), "workflow_1", {
      expectedVersion: 1,
      name: "Multi-trigger workflow",
      description: "",
      steps: [workflow().steps[0]!],
      status: "active",
      trigger: triggers[0]!,
      triggers,
    });

    expect(planner.prepareWorkflow).toHaveBeenCalledTimes(2);
    expect(repository.updateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        automationTriggers: [
          expect.objectContaining({ trigger: expect.objectContaining({ id: "trigger_schedule" }) }),
          expect.objectContaining({ trigger: expect.objectContaining({ id: "trigger_event" }) }),
        ],
      }),
    );
  });

  it("preserves additional triggers when a legacy client omits the trigger collection", async () => {
    const triggers = [
      {
        id: "trigger_schedule",
        type: "schedule" as const,
        cron: "0 9 * * 1",
        timezone: "UTC",
        prompt: "Run weekly.",
        enabled: true,
        lastRunAt: null,
        nextRunAt,
      },
      {
        id: "trigger_event",
        type: "event" as const,
        provider: "linear",
        event: "issue.created",
        integrationId: "gint_linear_1",
        filters: {},
        prompt: "Review the issue.",
      },
    ];
    const repository = fakeWorkflowRepository({
      workflow: workflow({ trigger: triggers[0]!, triggers }),
    });
    const planner = fakePlanner();
    const service = workflowService(repository, { planner });

    await service.updateWorkflow(actor(), "workflow_1", {
      expectedVersion: 1,
      name: "Renamed workflow",
      description: "",
      steps: [workflow().steps[0]!],
      status: "active",
      trigger: {
        type: "schedule",
        cron: "0 9 * * 1",
        timezone: "UTC",
        prompt: "Run weekly.",
        enabled: true,
      },
    });

    expect(planner.prepareWorkflow).toHaveBeenCalledTimes(2);
    expect(repository.updateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        automationTriggers: [
          expect.objectContaining({ trigger: expect.objectContaining({ id: "trigger_schedule" }) }),
          expect.objectContaining({ trigger: expect.objectContaining({ id: "trigger_event" }) }),
        ],
      }),
    );
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
      source: "workflow",
      workflowId: "weekly-research",
    });
    expect(repository.recordRunNow).not.toHaveBeenCalled();
  });

  it("uses step instructions as the request when run-now has no extra context", async () => {
    const scheduled = workflow({
      trigger: {
        type: "schedule",
        cron: "0 9 * * 1",
        timezone: "UTC",
        prompt: "Run this workflow.",
        enabled: true,
        lastRunAt: null,
        nextRunAt,
      },
      steps: [
        {
          id: "step_1",
          title: "Research",
          model: "provider/model",
          instructions: "Summarize what shipped today.",
        },
      ],
    });
    const taskCreator = fakeTaskCreator();
    const planner = fakePlanner();
    const service = workflowService(fakeWorkflowRepository({ workflow: scheduled }), {
      planner,
      taskCreator,
    });

    await service.runWorkflowNow(actor(), scheduled.id, "run-now-default-context");

    expect(planner.prepareWorkflow).toHaveBeenCalledWith({
      actor: actor(),
      workflow: scheduled,
      prompt: "Summarize what shipped today.",
    });
    expect(taskCreator.create).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "Summarize what shipped today." }),
    );
  });

  it("tests a complete draft without activating its triggers", async () => {
    const draft = workflow({ status: "draft", trigger: { type: "manual" } });
    const repository = fakeWorkflowRepository({ workflow: draft });
    const taskCreator = fakeTaskCreator();
    const service = workflowService(repository, { taskCreator });

    await service.runWorkflowNow(actor(), draft.id, "test-draft-1");

    expect(taskCreator.create).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "test-draft-1",
        source: "workflow",
        workflowId: draft.slug,
      }),
    );
    expect(repository.updateWorkflow).not.toHaveBeenCalled();
  });

  it("applies model overrides to the invocation snapshot without editing saved steps", async () => {
    const saved = workflow({
      steps: [
        {
          id: "step_1",
          title: " Build ",
          model: "codex",
          runtimeModel: "openai/gpt-5.6-sol",
          reasoningEffort: "high",
          instructions: "  Build it.\n",
        },
        { id: "step_2", title: "Review", model: "sonnet-5", instructions: "Review it." },
      ],
    });
    const repository = fakeWorkflowRepository({ workflow: saved });
    const planner = fakePlanner();
    const service = workflowService(repository, { planner });
    await service.invokeWorkflow(actor(), saved.id, {
      idempotencyKey: "override-1",
      description: "Ship it.",
      stepModelOverrides: [{ id: "step_1", model: "gpt-5.5" }],
    });
    expect(planner.prepareWorkflow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workflow: {
          ...saved,
          steps: [
            { id: "step_1", title: " Build ", model: "gpt-5.5", instructions: "  Build it.\n" },
            saved.steps[1],
          ],
        },
      }),
    );
    expect(saved.steps[0]).toMatchObject({
      model: "codex",
      runtimeModel: "openai/gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(repository.updateWorkflow).not.toHaveBeenCalled();
    await service.invokeWorkflow(actor(), saved.id, {
      idempotencyKey: "default-1",
      description: "Again.",
    });
    expect(planner.prepareWorkflow).toHaveBeenLastCalledWith(
      expect.objectContaining({ workflow: saved }),
    );
  });

  it.each([
    [{ id: "missing", model: "codex" }],
    [
      { id: "step_1", model: "codex" },
      { id: "step_1", model: "gpt-5.5" },
    ],
  ])("rejects unknown or duplicate model override steps", async (...stepModelOverrides) => {
    const planner = fakePlanner();
    const service = workflowService(fakeWorkflowRepository(), { planner });
    await expect(
      service.invokeWorkflow(actor(), "workflow_1", {
        idempotencyKey: "invalid-override",
        description: "Run it.",
        stepModelOverrides,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(planner.prepareWorkflow).not.toHaveBeenCalled();
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

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_1",
    workspaceId: "workspace_1",
    role: "admin",
    permissions: [WORKFLOW_READ_PERMISSION, WORKFLOW_WRITE_PERMISSION],
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
    scope: "company",
    slackChannel: { enabled: true, displayName: "", avatarUrl: "" },
    createdByUserId: "user_1",
    trigger: { type: "manual" },
    version: 1,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
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
} {
  return { prepareWorkflow: vi.fn(async () => executionPlan()) };
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

function fakeWorkflowRepository(options: { workflow?: Workflow } = {}): WorkflowRepository & {
  createWorkflow: ReturnType<typeof vi.fn>;
  updateWorkflow: ReturnType<typeof vi.fn>;
  recordRunNow: ReturnType<typeof vi.fn>;
  setWorkflowMemoryEnabled: ReturnType<typeof vi.fn>;
  clearWorkflowMemory: ReturnType<typeof vi.fn>;
} {
  const stored = options.workflow ?? workflow();
  let storedMemory: WorkflowMemory = {
    workflowId: stored.id,
    enabled: false,
    content: "Remembered from the last run.",
    updatedAt: now,
  };
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
    getWorkflowMemory: vi.fn(async ({ workflowId }) =>
      workflowId === stored.id || workflowId === stored.slug ? storedMemory : null,
    ),
    setWorkflowMemoryEnabled: vi.fn(async ({ enabled }) => {
      storedMemory = { ...storedMemory, enabled };
      return storedMemory;
    }),
    clearWorkflowMemory: vi.fn(async () => {
      storedMemory = { ...storedMemory, content: "", updatedAt: null };
      return storedMemory;
    }),
  };
}
