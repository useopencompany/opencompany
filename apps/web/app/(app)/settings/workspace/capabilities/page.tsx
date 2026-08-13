import { GoatCapabilitiesPanel } from "@/components/GoatCapabilitiesPanel";
import { currentGoatUser } from "@/lib/auth";
import { getWorkspaceCapabilitySettingsAction } from "@/lib/capabilities/actions";

export default async function WorkspaceCapabilitiesPage() {
  const context = await currentGoatUser();
  const { capabilities, sessionBudgetUsdMicros } = await getWorkspaceCapabilitySettingsAction();
  return (
    <GoatCapabilitiesPanel
      capabilities={capabilities}
      sessionBudgetUsdMicros={sessionBudgetUsdMicros}
      isAdmin={context.role === "admin"}
    />
  );
}
