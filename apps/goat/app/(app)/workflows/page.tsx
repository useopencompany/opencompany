import { GoatWorkflowsRoute } from "@/components/GoatRoutes";
import { currentGoatUser } from "@/lib/auth";
import { listGoatWorkflows } from "@/lib/workflows";

export default async function WorkflowsPage() {
  const context = await currentGoatUser();
  const workflows = await listGoatWorkflows(context.workspace.id);
  return <GoatWorkflowsRoute workflows={workflows} canEdit={context.role === "admin"} />;
}
