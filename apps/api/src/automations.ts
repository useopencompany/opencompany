import {
  type Actor,
  type AutomationExecutionPlan,
  type AutomationExecutionPlanner,
  type AutomationTaskCreator,
  TaskApplicationService,
  TaskScheduleApplicationService,
  WorkflowApplicationService,
} from "@opencompany/core";
import type { ResolvedChatAttachments } from "@opencompany/db/chat-repository";
import type { GoatHarnessSpec } from "@opencompany/db/goat-schema";
import { PostgresTaskRepository } from "@opencompany/db/task-repository";
import {
  PostgresTaskScheduleRepository,
  PostgresWorkflowRepository,
  type WorkflowSqlExecute,
} from "@opencompany/db/workflow-repository";
import { normalizeGoatScheduleDefinition } from "@opencompany/goat-agent/schedule-rules";
import { prepareGoatWorkflowRunForUser } from "@opencompany/goat-agent/workflow-tasks";
import { validateGoatWorkflowFields } from "@opencompany/goat-agent/workflows";

type AutomationServicesInput = {
  execute: WorkflowSqlExecute;
  resolveAttachments(input: {
    actor: Actor;
    attachmentIds: readonly string[];
  }): Promise<ResolvedChatAttachments>;
  fetch?: typeof globalThis.fetch;
  runnerUrl?: string;
  runnerToken?: string;
  now?: () => Date;
};

export function createAutomationServices(input: AutomationServicesInput) {
  const runnerUrl =
    input.runnerUrl?.trim() ||
    process.env.RUNNER_INTERNAL_URL?.trim() ||
    process.env.RUNNER_PUBLIC_URL?.trim();
  const runnerToken = input.runnerToken?.trim() || process.env.RUNNER_INTERNAL_TOKEN?.trim();
  const planner: AutomationExecutionPlanner = {
    prepareWorkflow: async ({ actor, workflow, prompt }) => {
      const prepared = await prepareGoatWorkflowRunForUser({
        userWorkosId: actor.userId,
        workspaceId: actor.workspaceId,
        workflow: {
          id: workflow.slug,
          name: workflow.name,
          description: workflow.description,
          steps: workflow.steps as never,
        },
        description: prompt,
      });
      const first = prepared.stepSelections[0];
      if (!first) throw new Error("Workflow preparation returned no execution step.");
      return {
        engine: first.engine,
        model: first.model,
        payload: prepared.harnessSpec,
      } satisfies AutomationExecutionPlan;
    },
    prepareTaskSchedule: async ({ actor, prompt }) =>
      planTaskScheduleHarness(
        { actorId: actor.userId, prompt },
        {
          ...(input.fetch ? { fetch: input.fetch } : {}),
          ...(runnerUrl ? { runnerUrl } : {}),
          ...(runnerToken ? { runnerToken } : {}),
        },
      ),
  };
  const taskCreator: AutomationTaskCreator = {
    create: async (command) => {
      const harness = harnessSpec(command.execution.payload);
      const service = new TaskApplicationService(
        new PostgresTaskRepository(input.execute, {
          resolveAttachments: ({ actor, attachmentIds }) =>
            input.resolveAttachments({ actor, attachmentIds }),
          resolveHarness: async () => harness,
          ...(input.now ? { now: input.now } : {}),
        }),
      );
      return service.createTask(command.actor, {
        idempotencyKey: command.idempotencyKey,
        name: command.name,
        goal: command.goal,
        engine: command.execution.engine,
        model: command.execution.model,
        source: command.source,
        ...(command.workflowId ? { workflowId: command.workflowId } : {}),
        ...(command.scheduleId ? { scheduleId: command.scheduleId } : {}),
        ...(command.attachmentIds ? { attachmentIds: command.attachmentIds } : {}),
      });
    },
  };
  const options = {
    scheduleRules: { normalize: normalizeGoatScheduleDefinition },
    planner,
    taskCreator,
    ...(input.now ? { now: input.now } : {}),
  };
  return {
    workflows: new WorkflowApplicationService(new PostgresWorkflowRepository(input.execute), {
      ...options,
      validateDefinition: (definition) =>
        validateGoatWorkflowFields({
          ...definition,
          steps: definition.steps as never,
          trigger: definition.trigger as never,
        }),
    }),
    schedules: new TaskScheduleApplicationService(
      new PostgresTaskScheduleRepository(input.execute),
      options,
    ),
  };
}

async function planTaskScheduleHarness(
  command: { actorId: string; prompt: string },
  options: {
    fetch?: typeof globalThis.fetch;
    runnerUrl?: string;
    runnerToken?: string;
  },
): Promise<AutomationExecutionPlan> {
  const runnerUrl = options.runnerUrl?.trim().replace(/\/+$/u, "");
  const token = options.runnerToken?.trim();
  if (!runnerUrl || !token) throw new Error("Task schedule planning is not configured.");
  const fetchImpl = (options.fetch ?? globalThis.fetch).bind(globalThis);
  const response = await fetchImpl(`${runnerUrl}/internal/goat/task-harness/plan`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ userWorkosId: command.actorId, prompt: command.prompt }),
  });
  if (!response.ok) {
    throw new Error(`Task schedule planning failed with status ${response.status}.`);
  }
  const body = (await response.json()) as { harnessSpec?: unknown };
  const harness = harnessSpec(body.harnessSpec);
  return { engine: harness.engine, model: harness.model, payload: harness };
}

function harnessSpec(value: unknown): GoatHarnessSpec {
  if (!isRecord(value)) throw new Error("Automation planning returned an invalid execution plan.");
  if (
    value.engine !== "opencompany" &&
    value.engine !== "codex" &&
    value.engine !== "claude_code"
  ) {
    throw new Error("Automation planning returned an invalid execution engine.");
  }
  if (typeof value.model !== "string" || !value.model.trim()) {
    throw new Error("Automation planning returned an invalid execution model.");
  }
  return value as GoatHarnessSpec;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
