import IntegrationsView from "@/components/IntegrationsView";
import { currentWorkspace } from "@/lib/auth";
import { loadWorkspaceIntegrationState } from "@/lib/integrations/actions";
import { loadWorkspaceToolPolicyOverrides } from "@/lib/tool-policies/data";

export default async function IntegrationsPage() {
  const { workspace } = await currentWorkspace();
  const [integrations, toolPolicies] = await Promise.all([
    loadWorkspaceIntegrationState(),
    loadWorkspaceToolPolicyOverrides(workspace.id),
  ]);

  return <IntegrationsView integrations={integrations} toolPolicies={toolPolicies} />;
}
