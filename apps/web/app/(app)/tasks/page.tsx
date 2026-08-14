import { TasksWorkflowsDisabledRoute } from "@/components/Routes";
import { TasksBoardRoute } from "@/components/TasksBoard";
import { currentUser } from "@/lib/auth";
import { listHeadlessWorkflows } from "@/lib/headless-automation-server";

export default async function TasksPage() {
  const context = await currentUser();
  if (!context.user.taskSpawningEnabled) {
    return <TasksWorkflowsDisabledRoute />;
  }

  const workflows = await listHeadlessWorkflows();
  const workflowNames = Object.fromEntries(
    workflows.map((workflow) => [workflow.slug, workflow.name]),
  );
  return (
    <TasksBoardRoute workflowNames={workflowNames} initialViewMode={context.user.taskViewMode} />
  );
}
