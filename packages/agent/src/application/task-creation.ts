import { randomUUID } from "node:crypto";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { captureProductTaskSpawned } from "@opencompany/analytics/product/server";
import {
  type Actor,
  TASK_WRITE_PERMISSION,
  TaskApplicationService,
  type TaskSource,
} from "@opencompany/core";
import { getDb } from "@opencompany/db/client";
import type {
  ChatMessageAttachment,
  HarnessEngine,
  HarnessSpec,
  Task,
} from "@opencompany/db/product-schema";
import { tasks, workspaceMembers } from "@opencompany/db/product-schema";
import { PostgresTaskRepository } from "@opencompany/db/task-repository";
import { and, asc, eq } from "drizzle-orm";
import { getAvailableHarnessTools } from "../integrations/google-data";
import { normalizeTaskName } from "../task-display";

export type TaskCreationCommand = {
  actorId: string;
  workspaceId?: string | null;
  brainRef?: string | null;
  prompt: string;
  model: AgentModelId;
  name?: string;
  engine?: HarnessEngine;
  harnessSpec?: HarnessSpec;
  scheduleId?: string;
  scheduledFor?: Date;
  workflowId?: string;
  workflowBrainRef?: string;
  attachments?: ChatMessageAttachment[];
  attachmentTexts?: Record<string, string> | null;
  source?: TaskSource;
  idempotencyKey?: string;
};

export type TaskCreationDependencies = {
  wakeTaskWorker: () => Promise<unknown> | unknown;
  defer: (work: Promise<unknown>) => void;
};

export type TaskUpdateCommand = {
  actorId: string;
  workspaceId: string;
  taskId: string;
  name: string;
};

export async function createTaskForActor(
  input: TaskCreationCommand,
  dependencies: TaskCreationDependencies,
): Promise<Task> {
  const now = new Date();
  const name = normalizeTaskName(input.name, input.prompt);
  const tools = input.harnessSpec ? [] : await getAvailableHarnessTools(input.actorId);
  const harnessSpec: HarnessSpec = input.harnessSpec ?? {
    schemaVersion: "goat.harness.v1",
    engine: input.engine ?? "opencompany",
    model: input.model,
    systemPrompt: "",
    initialUserMessage: input.prompt,
    tools,
    skills: [],
    maxModelSteps: 16,
    resultMode: "assistant_final",
  };
  const attachments = input.attachments ?? [];
  const workspaceId = await resolveWorkspaceId(input.actorId, input.workspaceId, harnessSpec);
  const actor: Actor = {
    userId: input.actorId,
    workspaceId,
    role: "member",
    permissions: [TASK_WRITE_PERMISSION],
    authenticationMethod: "service",
  };
  const repository = new PostgresTaskRepository((query) => getDb().execute(query), {
    now: () => now,
    resolveHarness: async () => harnessSpec,
    compatibility: {
      ...(attachments.length > 0 || input.attachmentTexts
        ? {
            resolvedAttachments: {
              attachments,
              attachmentTexts: input.attachmentTexts ?? null,
            },
          }
        : {}),
      brainRef: input.brainRef ?? null,
      workflowBrainRef: input.workflowBrainRef ?? null,
      initialMessageContent: harnessSpec.initialUserMessage.trim() || input.prompt,
    },
  });
  const created = await new TaskApplicationService(repository).createTask(actor, {
    idempotencyKey: input.idempotencyKey ?? `task:${randomUUID()}`,
    name,
    goal: input.prompt,
    engine: harnessSpec.engine,
    model: input.model,
    source: input.source ?? "manual",
    ...(attachments.length > 0 ? { attachmentIds: attachments.map(({ id }) => id) } : {}),
    ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
    ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
  });
  const [task] = await getDb().select().from(tasks).where(eq(tasks.id, created.task.id)).limit(1);
  if (!task) throw new Error("Canonical Task creation did not materialize its Task record.");

  dependencies.defer(captureTaskSpawned(task, workspaceId));
  await Promise.resolve(dependencies.wakeTaskWorker()).catch((error) => {
    console.warn("opencompany durable task wake failed; the turn remains queued for polling.", {
      event: "goat.durable_task_created_wake_failed",
      task_id: task.id,
      error,
    });
  });
  return task;
}

export async function updateTaskForActor(input: TaskUpdateCommand) {
  const actor: Actor = {
    userId: input.actorId,
    workspaceId: input.workspaceId,
    role: "member",
    permissions: [TASK_WRITE_PERMISSION],
    authenticationMethod: "service",
  };
  return new TaskApplicationService(
    new PostgresTaskRepository((query) => getDb().execute(query)),
  ).updateTask(actor, input.taskId, { name: input.name });
}

function captureTaskSpawned(task: Task, workspaceId: string) {
  return captureProductTaskSpawned({
    userWorkosId: task.userWorkosId,
    workspaceId,
    taskId: task.id,
    displayId: task.displayId,
    engine: task.harnessSpec.engine,
    model: task.model,
    workflowId: task.workflowId,
    scheduleId: task.scheduleId,
    trigger: task.source === "schedule" ? "schedule" : "manual",
  }).catch((error) => {
    console.warn("opencompany task spawn analytics failed.", {
      event: "goat.task_spawned_analytics_failed",
      task_id: task.id,
      error,
    });
  });
}

async function resolveWorkspaceId(
  actorId: string,
  requestedWorkspaceId: string | null | undefined,
  harnessSpec: HarnessSpec,
) {
  const preferredWorkspaceId = requestedWorkspaceId?.trim() || harnessSpec.workflow?.workspaceId;
  const [membership] = await getDb()
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userWorkosId, actorId),
        ...(preferredWorkspaceId ? [eq(workspaceMembers.workspaceId, preferredWorkspaceId)] : []),
      ),
    )
    .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.workspaceId))
    .limit(1);
  if (!membership) {
    throw new Error("Unable to create a Task without an actor workspace membership.");
  }
  return membership.workspaceId;
}
