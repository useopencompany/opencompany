import {
  type Actor,
  type AutomationExecutionPlan,
  type AutomationExecutionPlanner,
  type AutomationTaskCreator,
  CoreError,
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
import { generateGoatChatTitle } from "@opencompany/goat-agent/chat-title";
import { normalizeGoatScheduleDefinition } from "@opencompany/goat-agent/schedule-rules";
import { GoatSkillMentionError } from "@opencompany/goat-agent/skills";
import { prepareGoatWorkflowRunForUser } from "@opencompany/goat-agent/workflow-tasks";
import {
  GoatWorkflowMentionError,
  validateGoatWorkflowFields,
} from "@opencompany/goat-agent/workflows";

type AutomationServicesInput = {
  execute: WorkflowSqlExecute;
  resolveAttachments(input: {
    actor: Actor;
    attachmentIds: readonly string[];
  }): Promise<ResolvedChatAttachments>;
  fetch?: typeof globalThis.fetch;
  runnerUrl?: string;
  runnerToken?: string;
  gatewayApiKey?: string;
  defer?: (promise: Promise<void>) => void;
  now?: () => Date;
};

export function createAutomationServices(input: AutomationServicesInput) {
  const runnerUrl =
    input.runnerUrl?.trim() ||
    process.env.RUNNER_INTERNAL_URL?.trim() ||
    process.env.RUNNER_PUBLIC_URL?.trim();
  const runnerToken = input.runnerToken?.trim() || process.env.RUNNER_INTERNAL_TOKEN?.trim();
  const planner: AutomationExecutionPlanner = {
    prepareWorkflow: async ({ actor, workflow, prompt, skillIds }) => {
      const prepared = await prepareWorkflow({
        actor,
        workflow,
        prompt,
        ...(skillIds?.length ? { skillIds } : {}),
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
      const created = await service.createTask(command.actor, {
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
      if (command.source === "workflow" && !created.idempotentReplay) {
        const titleUpdate = refineWorkflowTaskTitle({
          service,
          actor: command.actor,
          taskId: created.task.id,
          conversationId: created.task.conversationId,
          workflowName: command.name,
          description: command.goal,
          ...(input.gatewayApiKey ? { apiKey: input.gatewayApiKey } : {}),
        });
        if (input.defer) input.defer(titleUpdate);
        else void titleUpdate;
      }
      return created;
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

export async function refineWorkflowTaskTitle(input: {
  service: Pick<TaskApplicationService, "updateTask">;
  actor: Actor;
  taskId: string;
  conversationId: string;
  workflowName: string;
  description: string;
  apiKey?: string;
  generateTitle?: typeof generateGoatChatTitle;
}) {
  if (!input.apiKey?.trim()) return;
  try {
    const title = await (input.generateTitle ?? generateGoatChatTitle)({
      content: input.description,
      fallbackTitle: input.workflowName,
      apiKey: input.apiKey,
      userWorkosId: input.actor.userId,
      chatSessionId: input.conversationId,
    });
    if (!title || title === input.workflowName) return;
    await input.service.updateTask(input.actor, input.taskId, { name: title });
  } catch (error) {
    console.warn("Workflow Task title refinement failed.", {
      event: "opencompany.workflow_task_title_failed",
      task_id: input.taskId,
      error,
    });
  }
}

async function prepareWorkflow(
  input: Parameters<AutomationExecutionPlanner["prepareWorkflow"]>[0],
) {
  try {
    return await prepareGoatWorkflowRunForUser({
      userWorkosId: input.actor.userId,
      workspaceId: input.actor.workspaceId,
      workflow: {
        id: input.workflow.slug,
        name: input.workflow.name,
        description: input.workflow.description,
        steps: input.workflow.steps as never,
      },
      description: input.prompt,
      ...(input.skillIds?.length ? { skillMentions: input.skillIds.map((id) => ({ id })) } : {}),
    });
  } catch (error) {
    if (error instanceof GoatSkillMentionError || error instanceof GoatWorkflowMentionError) {
      throw new CoreError("invalid_argument", error.message);
    }
    throw error;
  }
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
