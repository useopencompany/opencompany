import {
  getGoatCapabilitySessionBudgetUsdMicros,
  listGoatWorkspaceCapabilities,
} from "@opencompany/db/goat-capabilities";
import { GoatCapabilitiesPanel } from "@/components/GoatCapabilitiesPanel";
import { currentGoatUser } from "@/lib/auth";

export default async function WorkspaceCapabilitiesPage() {
  const context = await currentGoatUser();
  const [capabilities, sessionBudgetUsdMicros] = await Promise.all([
    listGoatWorkspaceCapabilities(context.workspace.id),
    getGoatCapabilitySessionBudgetUsdMicros(context.workspace.id),
  ]);
  return (
    <GoatCapabilitiesPanel
      capabilities={capabilities}
      sessionBudgetUsdMicros={sessionBudgetUsdMicros}
      isAdmin={context.role === "admin"}
    />
  );
}
