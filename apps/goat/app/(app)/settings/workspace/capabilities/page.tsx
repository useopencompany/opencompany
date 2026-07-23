import { listGoatWorkspaceCapabilities } from "@opencompany/db/goat-capabilities";
import { GoatCapabilitiesPanel } from "@/components/GoatCapabilitiesPanel";
import { currentGoatUser } from "@/lib/auth";

export default async function WorkspaceCapabilitiesPage() {
  const context = await currentGoatUser();
  const capabilities = await listGoatWorkspaceCapabilities(context.workspace.id);
  return <GoatCapabilitiesPanel capabilities={capabilities} isAdmin={context.role === "admin"} />;
}
