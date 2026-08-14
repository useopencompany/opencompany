import { TasksWorkflowsDisabledRoute } from "@/components/GoatRoutes";
import { GoatTasksBoardRoute } from "@/components/GoatTasksBoard";
import { currentGoatUser } from "@/lib/auth";
import { listHeadlessWorkflows } from "@/lib/headless-automation-server";

export default async function TasksPage() {
  const context = await currentGoatUser();
  if (!context.user.taskSpawningEnabled) {
    return <TasksWorkflowsDisabledRoute />;
  }

  const workflows = await listHeadlessWorkflows();
  const workflowNames = Object.fromEntries(
    workflows.map((workflow) => [workflow.slug, workflow.name]),
  );
  return (
    <GoatTasksBoardRoute
      workflowNames={workflowNames}
      initialViewMode={context.user.taskViewMode}
    />
  );
}
