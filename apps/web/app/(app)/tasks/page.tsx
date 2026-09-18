import { TasksBoardRoute } from "@/components/TasksBoard";
import { currentUser } from "@/lib/auth";
import { listHeadlessWorkflows } from "@/lib/headless-automation-server";

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ workflow?: string | string[] }>;
}) {
  const [context, workflows, query] = await Promise.all([
    currentUser(),
    listHeadlessWorkflows(),
    searchParams,
  ]);
  const workflowNames = Object.fromEntries(
    workflows.map((workflow) => [workflow.slug, workflow.name]),
  );
  // `?workflow=<slug>` lets a workflow's run history hand the board its own filter. A repeated
  // param arrives as an array, which names no single workflow, so it falls back to all Tasks.
  const initialWorkflowId =
    typeof query.workflow === "string" && query.workflow.trim() ? query.workflow : null;
  return (
    <TasksBoardRoute
      workflowNames={workflowNames}
      initialViewMode={context.user.taskViewMode}
      // Following "All runs" from a workflow asks for that workflow's whole history, so the saved
      // recency preference would only hide the older runs the link promised. It stays the default
      // everywhere else, and the range pill still switches back.
      initialTimeRange={initialWorkflowId ? "all" : context.user.taskTimeRange}
      initialWorkflowId={initialWorkflowId}
    />
  );
}
