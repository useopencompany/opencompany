// Shared fixtures for the WorkflowApplicationService suites.
import { vi } from "vitest";
import { type Actor, WORKFLOW_READ_PERMISSION, WORKFLOW_WRITE_PERMISSION } from "./actor";
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

export const now = new Date("2026-08-12T08:00:00.000Z");
export const nextRunAt = new Date("2026-08-13T09:00:00.000Z");

export function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_1",
    workspaceId: "workspace_1",
    role: "admin",
    permissions: [WORKFLOW_READ_PERMISSION, WORKFLOW_WRITE_PERMISSION],
    authenticationMethod: "session",
    ...overrides,
  };
}

export function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "workflow_1",
    slug: "weekly-research",
    kind: "workflow",
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
    ownerUserId: null,
    ownerActive: false,
    lastRunAt: null,
    trigger: { type: "manual" },
    version: 1,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function executionPlan() {
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

export function fakePlanner(): AutomationExecutionPlanner & {
  prepareWorkflow: ReturnType<typeof vi.fn>;
} {
  return { prepareWorkflow: vi.fn(async () => executionPlan()) };
}

export function fakeTaskCreator(): AutomationTaskCreator & { create: ReturnType<typeof vi.fn> } {
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

export function workflowService(
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

export function fakeWorkflowRepository(
  options: { workflow?: Workflow } = {},
): WorkflowRepository & {
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
    listRuns: vi.fn(async () => []),
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
