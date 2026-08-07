import { TasksWorkflowsDisabledRoute } from "@/components/AppRoutes";
import { TasksBoardRoute } from "@/components/TasksBoard";
import { currentUser } from "@/lib/auth";
import { listWorkflows } from "@/lib/workflows";

export default async function TasksPage() {
  const context = await currentUser();
  if (!context.user.taskSpawningEnabled) {
    return <TasksWorkflowsDisabledRoute />;
  }

  const workflows = await listWorkflows(context.workspace.id);
  const workflowNames = Object.fromEntries(
    workflows.map((workflow) => [workflow.slug, workflow.name]),
  );
  return (
    <TasksBoardRoute workflowNames={workflowNames} initialViewMode={context.user.taskViewMode} />
  );
}
