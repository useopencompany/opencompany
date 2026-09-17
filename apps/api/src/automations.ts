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
  taskNameFromGoal,
  WorkflowApplicationService,
} from "@opencompany/core";
import type { ResolvedChatAttachments } from "@opencompany/db/chat-repository";
import type { HarnessSpec } from "@opencompany/db/product-schema";
import { PostgresTaskRepository } from "@opencompany/db/task-repository";
import { validateWorkflowEventSubscription } from "@opencompany/db/workflow-event-subscriptions";
import {
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
      validateEventSubscription: (subscription) =>
        validateWorkflowEventSubscription(input.execute, subscription),
    }),
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
          // The workflow harness owns the visible request: this is explicit run context when
          // supplied, or the first step's instructions otherwise. Persist that same message so
          // the repository's canonical-command check and the conversation stay aligned.
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
        ...(command.attachmentIds ? { attachmentIds: command.attachmentIds } : {}),
      });
      if (
        shouldRefineWorkflowTaskTitle({
          source: command.source,
          workflowName: command.name,
          taskName: created.task.name,
          idempotentReplay: created.idempotentReplay,
        })
      ) {
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

export function shouldRefineWorkflowTaskTitle(input: {
  source: "workflow" | "schedule";
  workflowName: string;
  taskName: string;
  idempotentReplay: boolean;
}) {
  if (input.source !== "workflow") return false;
  // New Tasks always get one refinement attempt. On replay, compare against the same canonical
  // normalization used by Task creation so names such as "ship-feature" and "Ship-feature" do
  // not incorrectly look like a previously refined title.
  if (!input.idempotentReplay) return true;
  return input.taskName === taskNameFromGoal(input.workflowName);
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
        scope: input.workflow.scope,
        // Claiming a creator-less legacy workflow as Personal assigns this actor in the same
        // update. The planner must use that effective owner before the repository write lands.
        createdByUserId:
          input.workflow.scope === "personal"
            ? (input.workflow.createdByUserId ?? input.actor.userId)
            : input.workflow.createdByUserId,
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
