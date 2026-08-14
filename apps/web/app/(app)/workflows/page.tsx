import { TasksWorkflowsDisabledRoute, WorkflowsRoute } from "@/components/Routes";
import { currentUser } from "@/lib/auth";
import { listHeadlessWorkflows } from "@/lib/headless-automation-server";

export default async function WorkflowsPage() {
  const context = await currentUser();
  if (!context.user.taskSpawningEnabled) {
    return <TasksWorkflowsDisabledRoute />;
  }

  const workflows = await listHeadlessWorkflows();
  return <WorkflowsRoute workflows={workflows} workspaceId={context.workspace.id} canEdit />;
}
