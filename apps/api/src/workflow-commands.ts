import { randomUUID } from "node:crypto";
import { DEFAULT_WORKFLOW_MODEL_TOKEN } from "@opencompany/agent/workflow-model-options";
import { type WorkflowCommand, WorkflowCommandSchema } from "@opencompany/agent/workflow-tool";
import {
  type Actor,
  CoreError,
  type Workflow,
  type WorkflowApplicationService,
  workflowActivationDisabledReason,
} from "@opencompany/core";

const editable = [
  "name",
  "description",
  "instructions",
  "status",
  "scope",
  "schedule",
  "memoryEnabled",
] as const;

// A small authoring adapter over the same application service as the editor. No second
// persistence model: version checks, planning, permissions and scheduling remain canonical.
export async function executeWorkflowCommand(input: {
  actor: Actor;
  command: unknown;
  idempotencyKey: string;
  workflows: WorkflowApplicationService;
}) {
  const parsed = WorkflowCommandSchema.safeParse(input.command);
  if (!parsed.success)
    throw new CoreError(
      "invalid_argument",
      "Invalid workflow arguments: " +
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  const args = parsed.data;
  const { actor, workflows: service } = input;
  validateCommand(args);
  if (args.command === "list") {
    const page = await service.listWorkflows(actor, {
      limit: 50,
      ...(args.cursor ? { cursor: args.cursor } : {}),
    });
    return {
      ok: true,
      workflows: page.workflows.map((workflow) => {
        const { steps: _steps, ...summary } = workflowForTool(workflow);
        return { ...summary, url: workflowUrl(workflow) };
      }),
      nextCursor: page.nextCursor,
    };
  }
  let workflow: Workflow;
  let operation: string = args.command;
  let changedFields: string[] = [];
  if (args.command === "create") {
    const created = await service.createWorkflow(actor, {
      idempotencyKey: input.idempotencyKey,
      name: args.name!,
      description: args.description ?? "",
      scope: args.scope ?? "personal",
    });
    workflow = created.workflow;
    // A replay must never overwrite edits made after the original call. If configuration
    // failed, return the recoverable draft and let the agent read/update that exact ID.
    if (created.idempotentReplay)
      return result(
        workflow,
        "replayed",
        [],
        workflow.version === 1 || (args.status === "active" && workflow.status !== "active")
          ? "The existing workflow was recovered without reapplying configuration. Read and update this draft to finish."
          : undefined,
      );
    changedFields = ["name", "description", "scope"];
  } else {
    workflow = await service.getWorkflow(actor, args.workflowId!);
    if (args.command === "read") return result(workflow, "read", []);
    if (args.command === "run") {
      const run = await service.invokeWorkflow(actor, workflow.id, {
        idempotencyKey: input.idempotencyKey,
        description: args.prompt!,
      });
      return {
        ok: true,
        taskId: run.task.id,
        taskDisplayId: run.task.displayId,
        taskName: run.task.name,
        prompt: run.task.goal,
        status: run.idempotentReplay ? "already_started" : "queued",
      };
    }
    if (workflow.version !== args.expectedVersion)
      throw new CoreError(
        "conflict",
        "The workflow changed since you read it. Read it again and confirm the intended changes before retrying.",
      );
  }
  try {
    if (args.command === "archive") {
      const archived = await service.archiveWorkflow(actor, workflow.id, workflow.version);
      return {
        ok: true,
        operation: "archived",
        workflow: {
          id: workflow.id,
          slug: workflow.slug,
          name: workflow.name,
          scope: workflow.scope,
          archived: true,
          version: archived.version,
          url: workflowUrl(workflow),
        },
        changedFields: ["archived"],
      };
    }
    if (args.command === "clear_memory") {
      await service.clearWorkflowMemory(actor, workflow.id);
      return result(workflow, "memory_cleared", ["memory"]);
    }
    const activateAfterConfiguration =
      args.status === "active" &&
      (args.command === "create" ||
        (workflow.status !== "active" && args.memoryEnabled !== undefined));
    const changesDefinition =
      args.command !== "update" ||
      editable.some((key) => key !== "memoryEnabled" && args[key] !== undefined);
    if (changesDefinition) {
      const patch = definition(workflow, args);
      // Configure drafts and memory before activation can allow automatic execution.
      // Failure leaves one identified recoverable draft.
      if (args.command === "create" || activateAfterConfiguration) patch.status = "draft";
      workflow = (
        await service.updateWorkflow(actor, workflow.id, {
          expectedVersion: workflow.version,
          ...patch,
        })
      ).workflow;
      changedFields.push(
        ...editable.filter((key) => key !== "memoryEnabled" && args[key] !== undefined),
      );
      if (args.command === "activate" || args.command === "pause") changedFields.push("status");
    }
    if (args.memoryEnabled !== undefined) {
      await service.setWorkflowMemoryEnabled(actor, workflow.id, args.memoryEnabled);
      changedFields.push("memoryEnabled");
    }
    if (activateAfterConfiguration) {
      workflow = (
        await service.updateWorkflow(actor, workflow.id, {
          expectedVersion: workflow.version,
          ...definition(workflow, { command: "activate" }),
        })
      ).workflow;
    }
    operation =
      args.command === "create"
        ? "created"
        : args.command === "activate"
          ? "activated"
          : args.command === "pause"
            ? "paused"
            : "updated";
    workflow = await service.getWorkflow(actor, workflow.id);
    return result(workflow, operation, changedFields);
  } catch (error) {
    // Report partial writes honestly, including a draft created before configuration failed.
    const current = await service.getWorkflow(actor, workflow.id);
    return result(
      current,
      operation,
      changedFields,
      error instanceof Error ? error.message : "Workflow configuration failed.",
    );
  }

  async function result(value: Workflow, action: string, changed: string[], error?: string) {
    const memory = await service.getWorkflowMemory(actor, value.id);
    return {
      ok: !error,
      operation: action,
      ...(error ? { error, partial: args.command === "create" || changed.length > 0 } : {}),
      workflow: {
        ...workflowForTool(value),
        url: workflowUrl(value),
        memory: { enabled: memory.enabled, updatedAt: memory.updatedAt },
        activationBlockers: [workflowActivationDisabledReason(value.steps)].filter(Boolean),
      },
      changedFields: [...new Set(changed)],
    };
  }
}

function definition(current: Workflow, args: WorkflowCommand) {
  if (args.instructions !== undefined && current.steps.length !== 1)
    throw new CoreError(
      "invalid_argument",
      "This workflow has multiple steps. Edit its instructions in the workflow editor.",
    );
  const triggers =
    current.triggers ??
    (current.trigger.type === "manual" ? [] : [{ ...current.trigger, id: randomUUID() }]);
  if (
    args.schedule !== undefined &&
    (triggers.length > 1 || triggers.some((trigger) => trigger.type === "event"))
  )
    throw new CoreError(
      "invalid_argument",
      "This workflow has multiple or event triggers. Edit its triggers in the workflow editor.",
    );
  const nextTriggers =
    args.schedule === undefined
      ? triggers
      : args.schedule === null
        ? []
        : [
            {
              id: triggers[0]?.id ?? randomUUID(),
              type: "schedule" as const,
              ...args.schedule,
              enabled:
                args.schedule.enabled ??
                (triggers[0]?.type === "schedule" ? triggers[0].enabled : true),
              prompt: triggers[0]?.prompt ?? "Run this workflow.",
            },
          ];
  return {
    name: args.name ?? current.name,
    description: args.description ?? current.description,
    scope: args.scope ?? current.scope,
    slackChannel: current.slackChannel,
    steps: current.steps.map((step) => ({
      ...step,
      ...(args.command === "create" ? { model: DEFAULT_WORKFLOW_MODEL_TOKEN } : {}),
      ...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
    })),
    status:
      args.command === "activate"
        ? ("active" as const)
        : args.command === "pause"
          ? ("draft" as const)
          : (args.status ?? current.status),
    trigger: nextTriggers[0] ?? { type: "manual" as const },
    triggers: nextTriggers,
  };
}

function workflowUrl(workflow: Pick<Workflow, "slug">) {
  return `/workflows/${encodeURIComponent(workflow.slug)}`;
}
function validateCommand(args: WorkflowCommand) {
  const allowed = new Set<string>(["command"]);
  if (args.command === "list") allowed.add("cursor");
  else if (args.command === "create") {
    for (const field of editable) allowed.add(field);
    if (!args.name) throw new CoreError("invalid_argument", "Create requires a name.");
  } else {
    allowed.add("workflowId");
    if (!args.workflowId)
      throw new CoreError(
        "invalid_argument",
        "Select an exact workflow ID or slug from list/read.",
      );
    if (args.command === "run") {
      allowed.add("prompt");
      if (!args.prompt) throw new CoreError("invalid_argument", "Run requires a prompt.");
    } else if (args.command !== "read") {
      allowed.add("expectedVersion");
      if (args.expectedVersion === undefined)
        throw new CoreError(
          "invalid_argument",
          "Read the workflow and pass expectedVersion before changing it.",
        );
    }
    if (args.command === "update") for (const field of editable) allowed.add(field);
  }
  for (const key of Object.keys(args))
    if (!allowed.has(key))
      throw new CoreError("invalid_argument", `${key} is not supported by ${args.command}.`);
  if (args.command === "update" && !editable.some((key) => args[key] !== undefined))
    throw new CoreError("invalid_argument", "Provide at least one field to update.");
}

// Pausing preserves the configured schedule, but there is no pending automatic run.
function workflowForTool(workflow: Workflow) {
  const trigger = (value: Workflow["trigger"]) =>
    value.type === "schedule"
      ? {
          ...value,
          nextRunAt: workflow.status === "active" && value.enabled ? value.nextRunAt : null,
        }
      : value;
  return {
    ...workflow,
    trigger: trigger(workflow.trigger),
    ...(workflow.triggers
      ? { triggers: workflow.triggers.map((value) => ({ ...trigger(value), id: value.id })) }
      : {}),
  };
}
