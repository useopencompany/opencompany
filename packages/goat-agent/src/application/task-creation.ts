import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { captureGoatTaskSpawned } from "@opencompany/analytics/goat/server";
import { getDb } from "@opencompany/db/client";
import type {
  GoatChatMessageAttachment,
  GoatHarnessEngine,
  GoatHarnessSpec,
  GoatTask,
} from "@opencompany/db/goat-schema";
import { goatUsers } from "@opencompany/db/goat-schema";
import { createGoatTaskSession } from "@opencompany/db/goat-task-sessions";
import { eq } from "drizzle-orm";
import { TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } from "../feature-flags";
import { getGoatAvailableHarnessTools } from "../integrations/google-data";
import { normalizeGoatTaskName } from "../task-display";

export type GoatTaskCreationCommand = {
  actorId: string;
  workspaceId?: string | null;
  brainRef?: string | null;
  prompt: string;
  model: AgentModelId;
  name?: string;
  engine?: GoatHarnessEngine;
  harnessSpec?: GoatHarnessSpec;
  scheduleId?: string;
  scheduledFor?: Date;
  workflowId?: string;
  workflowBrainRef?: string;
  attachments?: GoatChatMessageAttachment[];
  attachmentTexts?: Record<string, string> | null;
};

export type GoatTaskCreationDependencies = {
  wakeTaskWorker: () => Promise<unknown> | unknown;
  defer: (work: Promise<unknown>) => void;
};

export async function createGoatTaskForActor(
  input: GoatTaskCreationCommand,
  dependencies: GoatTaskCreationDependencies,
): Promise<GoatTask> {
  const initialTaskSpawningState = await loadGoatTaskSpawningState(input.actorId);
  if (initialTaskSpawningState === null) {
    throw new Error("Unable to create a Goat task for an unknown user.");
  }
  if (!initialTaskSpawningState) {
    throw new Error(TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE);
  }

  const now = new Date();
  const name = normalizeGoatTaskName(input.name, input.prompt);
  const tools = input.harnessSpec ? [] : await getGoatAvailableHarnessTools(input.actorId);
  const harnessSpec: GoatHarnessSpec = input.harnessSpec ?? {
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
  let task: GoatTask;
  try {
    task = await createGoatTaskSession({
      userWorkosId: input.actorId,
      workspaceId: input.workspaceId ?? null,
      brainRef: input.brainRef ?? null,
      prompt: input.prompt,
      name,
      harnessSpec,
      scheduleId: input.scheduleId ?? null,
      scheduledFor: input.scheduledFor ?? null,
      workflowId: input.workflowId ?? null,
      workflowBrainRef: input.workflowBrainRef ?? null,
      attachments,
      attachmentTexts: input.attachmentTexts ?? null,
      now,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Unable to create Goat task session.") {
      throw error;
    }
    const currentTaskSpawningState = await loadGoatTaskSpawningState(input.actorId);
    if (currentTaskSpawningState === null) {
      throw new Error("Unable to create a Goat task for an unknown user.");
    }
    if (!currentTaskSpawningState) {
      throw new Error(TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE);
    }
    throw error;
  }

  dependencies.defer(captureTaskSpawned(task, input.workspaceId ?? null));
  await Promise.resolve(dependencies.wakeTaskWorker()).catch((error) => {
    console.warn("Goat durable task wake failed; the turn remains queued for polling.", {
      event: "goat.durable_task_created_wake_failed",
      task_id: task.id,
      error,
    });
  });
  return task;
}

function captureTaskSpawned(task: GoatTask, workspaceId: string | null | undefined) {
  return captureGoatTaskSpawned({
    userWorkosId: task.userWorkosId,
    workspaceId: workspaceId ?? task.harnessSpec.workflow?.workspaceId ?? null,
    taskId: task.id,
    displayId: task.displayId,
    engine: task.harnessSpec.engine,
    model: task.model,
    workflowId: task.workflowId,
    scheduleId: task.scheduleId,
    trigger: "manual",
  }).catch((error) => {
    console.warn("Goat task spawn analytics failed.", {
      event: "goat.task_spawned_analytics_failed",
      task_id: task.id,
      error,
    });
  });
}

async function loadGoatTaskSpawningState(actorId: string): Promise<boolean | null> {
  const [user] = await getDb()
    .select({ enabled: goatUsers.taskSpawningEnabled })
    .from(goatUsers)
    .where(eq(goatUsers.workosUserId, actorId))
    .limit(1);
  return user ? user.enabled : null;
}
