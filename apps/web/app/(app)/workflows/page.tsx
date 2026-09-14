import { TasksWorkflowsDisabledRoute, WorkflowsRoute } from "@/components/Routes";
import { currentUser } from "@/lib/auth";
import { listHeadlessWorkflows } from "@/lib/headless-automation-server";

export default async function WorkflowsPage() {
  const context = await currentUser();
  if (!context.user.taskSpawningEnabled) {
    return <TasksWorkflowsDisabledRoute />;
  }

  // The API only returns company workflows plus this user's personal ones, so every row here is
  // one they can open and edit.
  const workflows = await listHeadlessWorkflows();
  return <WorkflowsRoute workflows={workflows} workspaceId={context.workspace.id} canEdit />;
}
