import { TasksWorkflowsDisabledRoute, WorkflowsRoute } from "@/components/AppRoutes";
import { currentUser } from "@/lib/auth";
import { listWorkflows } from "@/lib/workflows";

export default async function WorkflowsPage() {
  const context = await currentUser();
  if (!context.user.taskSpawningEnabled) {
    return <TasksWorkflowsDisabledRoute />;
  }

  const workflows = await listWorkflows(context.workspace.id);
  return <WorkflowsRoute workflows={workflows} canEdit />;
}
