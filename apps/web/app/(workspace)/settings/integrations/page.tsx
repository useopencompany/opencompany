import IntegrationsView from "@/components/IntegrationsView";
import { currentWorkspace } from "@/lib/auth";
import { loadWorkspaceIntegrationState } from "@/lib/integrations/actions";
import { loadGoogleIntegrationState } from "@/lib/integrations/google-data";
import { loadWorkspaceToolPolicyOverrides } from "@/lib/tool-policies/data";

export default async function IntegrationsPage() {
  const { workspace } = await currentWorkspace();
  const [base, google, toolPolicies] = await Promise.all([
    loadWorkspaceIntegrationState(),
    loadGoogleIntegrationState(),
    loadWorkspaceToolPolicyOverrides(workspace.id),
  ]);

  return <IntegrationsView integrations={{ ...base, ...google }} toolPolicies={toolPolicies} />;
}
