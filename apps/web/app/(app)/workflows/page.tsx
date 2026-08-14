import { GoatWorkflowsRoute, TasksWorkflowsDisabledRoute } from "@/components/GoatRoutes";
import { currentGoatUser } from "@/lib/auth";
import { listHeadlessWorkflows } from "@/lib/headless-automation-server";

export default async function WorkflowsPage() {
  const context = await currentGoatUser();
  if (!context.user.taskSpawningEnabled) {
    return <TasksWorkflowsDisabledRoute />;
  }

  const workflows = await listHeadlessWorkflows();
  return <GoatWorkflowsRoute workflows={workflows} workspaceId={context.workspace.id} canEdit />;
}
