import { currentUser } from "@/lib/auth";
import { loadTaskChatSessionByIdForWorkspace } from "@/lib/chat";
import { TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { buildHarnessRun } from "@/lib/task-harness-run";
import { getCurrentUserTaskRun } from "@/lib/tasks";

type RouteContext = {
  params: Promise<{ taskId: string }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  const context = await currentUser({ optional: true });
  if (!context) return Response.json({ error: "Unauthorized." }, { status: 401 });
  if (!context.user.taskSpawningEnabled) {
    return Response.json({ error: TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE }, { status: 404 });
  }
  const { taskId } = await params;
  const runData = await getCurrentUserTaskRun(taskId);

  if (!runData) {
    return Response.json({ error: "Task not found." }, { status: 404 });
  }

  const { task, messages, events, modelUsage, toolUsage, sandboxUsage } = runData;
  const chat = task.sessionId
    ? await loadTaskChatSessionByIdForWorkspace({
        workspaceId: context.workspace.id,
        sessionId: task.sessionId,
      })
    : null;
  return Response.json(
    buildHarnessRun({
      task,
      messages,
      events,
      modelUsage,
      toolUsage,
      sandboxUsage,
      chat,
    }),
  );
}
