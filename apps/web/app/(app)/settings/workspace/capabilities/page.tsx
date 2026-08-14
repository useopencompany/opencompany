import { CapabilitiesPanel } from "@/components/CapabilitiesPanel";
import { currentUser } from "@/lib/auth";
import { getWorkspaceCapabilitySettingsAction } from "@/lib/capabilities/actions";

export default async function WorkspaceCapabilitiesPage() {
  const context = await currentUser();
  const { capabilities, sessionBudgetUsdMicros } = await getWorkspaceCapabilitySettingsAction();
  return (
    <CapabilitiesPanel
      capabilities={capabilities}
      sessionBudgetUsdMicros={sessionBudgetUsdMicros}
      isAdmin={context.role === "admin"}
    />
  );
}
