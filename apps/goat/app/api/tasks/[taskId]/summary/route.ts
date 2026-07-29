import { currentGoatUser } from "@/lib/auth";
import { TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { getCurrentUserGoatTaskSummary } from "@/lib/tasks";

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
  const summary = await getCurrentUserGoatTaskSummary(taskId);
  if (!summary) {
    return Response.json({ error: "Task not found." }, { status: 404 });
  }

  return Response.json(summary);
}
