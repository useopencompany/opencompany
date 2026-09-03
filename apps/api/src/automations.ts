import { normalizeScheduleDefinition } from "@opencompany/agent/schedule-rules";
import { SkillMentionError } from "@opencompany/agent/skills";
import { refineWorkflowTaskTitle } from "@opencompany/agent/workflow-task-title";
import {
  prepareWorkflowRunForUser,
  WorkflowPreparationError,
} from "@opencompany/agent/workflow-tasks";
import { validateWorkflowFields, WorkflowMentionError } from "@opencompany/agent/workflows";
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
import type { HarnessSpec } from "@opencompany/db/product-schema";
import { PostgresTaskRepository } from "@opencompany/db/task-repository";
import {
  PostgresTaskScheduleRepository,
  PostgresWorkflowRepository,
  type WorkflowSqlExecute,
} from "@opencompany/db/workflow-repository";

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
  const taskCreator = createAutomationTaskCreator({
    execute: input.execute,
    resolveAttachments: input.resolveAttachments,
    ...(input.gatewayApiKey ? { gatewayApiKey: input.gatewayApiKey } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  const options = {
    scheduleRules: { normalize: normalizeScheduleDefinition },
    planner,
    taskCreator,
    ...(input.now ? { now: input.now } : {}),
  };
  return {
    workflows: new WorkflowApplicationService(new PostgresWorkflowRepository(input.execute), {
      ...options,
      validateDefinition: (definition) =>
        validateWorkflowFields({
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

type AutomationTaskCreatorInput = {
  execute: WorkflowSqlExecute;
  resolveAttachments(input: {
    actor: Actor;
    attachmentIds: readonly string[];
  }): Promise<ResolvedChatAttachments>;
  gatewayApiKey?: string;
  now?: () => Date;
};

export function createAutomationTaskCreator(
  input: AutomationTaskCreatorInput,
): AutomationTaskCreator {
  return {
    create: async (command) => {
      const harness = harnessSpec(command.execution.payload);
      const service = new TaskApplicationService(
        new PostgresTaskRepository(input.execute, {
          resolveAttachments: ({ actor, attachmentIds }) =>
            input.resolveAttachments({ actor, attachmentIds }),
          resolveHarness: async () => harness,
          // Workflow harnesses frame the first turn as "Task: <name>\n\n<goal>",
          // so the persisted user message must match that framing. Without this
          // the repository's canonical-command check compares the framed harness
          // message against the bare goal and throws, masking every workflow
          // invocation as a generic 500. Mirrors the runner scheduler and the
          // shared task-creation helper.
          compatibility: {
            initialMessageContent: harness.initialUserMessage.trim() || command.goal,
          },
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
      // A replay also repairs an earlier best-effort generation failure. Once the Task has a
      // refined name, subsequent idempotent requests skip the model call.
      if (command.source === "workflow" && created.task.name === command.name) {
        const updated = await refineWorkflowTaskTitle(
          {
            taskId: created.task.id,
            conversationId: created.task.conversationId,
            workflowName: command.name,
            description: command.goal,
            actorId: command.actor.userId,
            ...(input.gatewayApiKey ? { apiKey: input.gatewayApiKey } : {}),
          },
          {
            updateTaskName: (name) => service.updateTask(command.actor, created.task.id, { name }),
          },
        );
        if (updated) return { ...created, task: updated.task };
      }
      return created;
    },
  };
}

async function prepareWorkflow(
  input: Parameters<AutomationExecutionPlanner["prepareWorkflow"]>[0],
) {
  try {
    return await prepareWorkflowRunForUser({
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
    throw mapWorkflowPreparationError(error);
  }
}

// Translates the expected, user-actionable failures from workflow preparation
// into typed CoreErrors so the API returns a specific status and message rather
// than a masked 500. Anything not matched here is rethrown unchanged so genuine
// bugs still surface as 500s and stay visible in observability.
export function mapWorkflowPreparationError(error: unknown): unknown {
  // A CoreError is already typed and actionable; keep it as-is.
  if (error instanceof CoreError) return error;
  // Skill and workflow mention problems are caused by user input.
  if (error instanceof SkillMentionError || error instanceof WorkflowMentionError) {
    return new CoreError("invalid_argument", error.message);
  }
  // A failed integration-state lookup is a transient dependency failure the
  // user can retry, not an internal bug.
  if (error instanceof WorkflowPreparationError) {
    return new CoreError("unavailable", error.message);
  }
  return error;
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

function harnessSpec(value: unknown): HarnessSpec {
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
  return value as HarnessSpec;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
