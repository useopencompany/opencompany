import { buildGoatHarnessRun } from "@/lib/task-harness-run";
import { getCurrentUserGoatTaskRun } from "@/lib/tasks";

type RouteContext = {
  params: Promise<{ taskId: string }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  const { taskId } = await params;
  const runData = await getCurrentUserGoatTaskRun(taskId);

  if (!runData) {
    return Response.json({ error: "Task not found." }, { status: 404 });
  }

  const { task, messages, events, modelUsage, toolUsage, sandboxUsage } = runData;
  return Response.json(
    buildGoatHarnessRun({
      task,
      messages,
      events,
      modelUsage,
      toolUsage,
      sandboxUsage,
    }),
  );
}
