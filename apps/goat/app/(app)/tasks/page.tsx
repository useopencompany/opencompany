import { TasksWorkflowsDisabledRoute } from "@/components/GoatRoutes";
import { GoatTasksBoardRoute } from "@/components/GoatTasksBoard";
import { currentGoatUser } from "@/lib/auth";
import { listGoatWorkflows } from "@/lib/workflows";

export default async function TasksPage() {
  const context = await currentGoatUser();
  if (!context.user.taskSpawningEnabled) {
    return <TasksWorkflowsDisabledRoute />;
  }

  const workflows = await listGoatWorkflows(context.workspace.id);
  const workflowNames = Object.fromEntries(
    workflows.map((workflow) => [workflow.slug, workflow.name]),
  );
  return <GoatTasksBoardRoute workflowNames={workflowNames} />;
}
