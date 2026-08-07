import {
  getCapabilitySessionBudgetUsdMicros,
  listWorkspaceCapabilities,
} from "@opencompany/db/capabilities";
import { CapabilitiesPanel } from "@/components/CapabilitiesPanel";
import { currentUser } from "@/lib/auth";

export default async function WorkspaceCapabilitiesPage() {
  const context = await currentUser();
  const [capabilities, sessionBudgetUsdMicros] = await Promise.all([
    listWorkspaceCapabilities(context.workspace.id),
    getCapabilitySessionBudgetUsdMicros(context.workspace.id),
  ]);
  return (
    <CapabilitiesPanel
      capabilities={capabilities}
      sessionBudgetUsdMicros={sessionBudgetUsdMicros}
      isAdmin={context.role === "admin"}
    />
  );
}
