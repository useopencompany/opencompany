"use server";

import { randomUUID } from "node:crypto";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import { goatTasks } from "@opencompany/db/goat-schema";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import { getGoatAvailableHarnessTools } from "@/lib/integrations/google-data";
import { normalizeGoatTaskName } from "@/lib/task-display";
import { triggerGoatTaskRun } from "@/lib/task-runner";
import { validateGoatTaskInput } from "@/lib/task-validation";

export type TaskFormState = {
  ok: boolean;
  error: string | null;
};

export type ArchiveTaskResult = {
  ok: boolean;
  error: string | null;
};

export async function listCurrentUserGoatTasks() {
  const { user } = await currentGoatUser();
  return getDb()
    .select()
    .from(goatTasks)
    .where(and(eq(goatTasks.userWorkosId, user.workosUserId), isNull(goatTasks.archivedAt)))
    .orderBy(desc(goatTasks.createdAt))
    .limit(50);
}

export async function getCurrentUserGoatTask(taskId: string) {
  const { user } = await currentGoatUser();
  const normalizedTaskId = taskId.trim().toUpperCase();
  const [task] = await getDb()
    .select()
    .from(goatTasks)
    .where(
      and(
        eq(goatTasks.userWorkosId, user.workosUserId),
        or(eq(goatTasks.id, taskId), eq(goatTasks.displayId, normalizedTaskId)),
      ),
    )
    .limit(1);

  return task ?? null;
}

export async function archiveGoatTaskAction(taskId: string): Promise<ArchiveTaskResult> {
  if (!taskId.trim()) {
    return { ok: false, error: "Could not archive task." };
  }

  const { user } = await currentGoatUser();
  const now = new Date();
  const [task] = await getDb()
    .update(goatTasks)
    .set({
      archivedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(goatTasks.id, taskId),
        eq(goatTasks.userWorkosId, user.workosUserId),
        isNull(goatTasks.archivedAt),
        inArray(goatTasks.status, ["succeeded", "failed"]),
      ),
    )
    .returning({ id: goatTasks.id });

  if (!task) {
    return { ok: false, error: "Could not archive task." };
  }

  revalidatePath("/");
  return { ok: true, error: null };
}

export async function createGoatTaskForUser(input: {
  userWorkosId: string;
  prompt: string;
  model: AgentModelId;
  name?: string;
}) {
  const id = `goat_task_${randomUUID()}`;
  const now = new Date();
  const name = normalizeGoatTaskName(input.name, input.prompt);
  const tools = await getGoatAvailableHarnessTools(input.userWorkosId);
  const [task] = await getDb()
    .insert(goatTasks)
    .values({
      id,
      name,
      userWorkosId: input.userWorkosId,
      prompt: input.prompt,
      model: input.model,
      status: "queued",
      stage: "queued",
      nextRunAt: now,
      updatedAt: now,
      harnessSpec: {
        prompt: input.prompt,
        model: input.model,
        tools,
        resultMode: "freeform",
      },
    })
    .returning();

  if (!task) {
    throw new Error("Unable to create Goat task.");
  }

  try {
    await triggerGoatTaskRun(id, {
      task_id: id,
      event: "goat.runner_task_created_dispatch",
    });
  } catch (error) {
    console.warn("Goat runner dispatch failed; the task remains queued for polling.", {
      event: "goat.runner_task_created_dispatch_failed",
      task_id: id,
      error,
    });
  }

  return task;
}

export async function createGoatTaskAction(
  _previousState: TaskFormState,
  formData: FormData,
): Promise<TaskFormState> {
  const context = await currentGoatUser();
  const parsed = validateGoatTaskInput({
    prompt: formData.get("prompt"),
    model: formData.get("model"),
  });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  await createGoatTaskForUser({
    userWorkosId: context.user.workosUserId,
    prompt: parsed.value.prompt,
    model: parsed.value.model,
  });

  revalidatePath("/");
  return { ok: true, error: null };
}
