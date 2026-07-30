import { currentGoatUser } from "@/lib/auth";
import { loadGoatChatSessionByIdForUser } from "@/lib/chat";
import { TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { buildGoatHarnessRun } from "@/lib/task-harness-run";
import { getCurrentUserGoatTaskRun } from "@/lib/tasks";

type RouteContext = {
  params: Promise<{ taskId: string }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return Response.json({ error: "Unauthorized." }, { status: 401 });
  if (!context.user.taskSpawningEnabled) {
    return Response.json({ error: TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE }, { status: 404 });
  }
  const { taskId } = await params;
  const runData = await getCurrentUserGoatTaskRun(taskId);

  if (!runData) {
    return Response.json({ error: "Task not found." }, { status: 404 });
  }

  const { task, messages, events, modelUsage, toolUsage, sandboxUsage } = runData;
  const chat = task.sessionId
    ? await loadGoatChatSessionByIdForUser({
        userWorkosId: context.user.workosUserId,
        sessionId: task.sessionId,
        kind: "task",
      })
    : null;
  return Response.json(
    buildGoatHarnessRun({
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
