"use server";

import { callRunner } from "@/lib/agent-sessions/runner";
import { currentWorkspace } from "@/lib/auth";
import { continueGoatTaskForActor } from "@/lib/goat-tasks/service";

export async function continueGoatTask(taskDisplayIdOrId: string, content: string) {
  const { authUser, user, workspace } = await currentWorkspace();
  return continueGoatTaskForActor({
    actor: "human",
    taskDisplayIdOrId,
    content,
    authUserWorkosId: authUser.id,
    appUserId: user.id,
    workspaceId: workspace.id,
    wakeRunner: (taskId) =>
      callRunner(`/internal/goat/tasks/${encodeURIComponent(taskId)}/run`, {
        workspace_id: workspace.id,
        event: "opencompany.goat_task_continue_wake_failed",
      }),
  });
}
