import IntegrationsView from "@/components/IntegrationsView";
import { currentWorkspace } from "@/lib/auth";
import { loadWorkspaceIntegrationState } from "@/lib/integrations/actions";
import { loadGoogleIntegrationState } from "@/lib/integrations/google-data";
import { loadNeonIntegrationState } from "@/lib/integrations/neon";
import { loadWorkspaceMcpSettingsForWorkspace } from "@/lib/mcp/data";
import { loadWorkspaceToolPolicyOverrides } from "@/lib/tool-policies/data";

export default async function IntegrationsPage() {
  const { workspace } = await currentWorkspace();
  const [base, google, neon, mcp, toolPolicies] = await Promise.all([
    loadWorkspaceIntegrationState(),
    loadGoogleIntegrationState(),
    loadNeonIntegrationState(),
    loadWorkspaceMcpSettingsForWorkspace(workspace.id),
    loadWorkspaceToolPolicyOverrides(workspace.id),
  ]);

  return (
    <IntegrationsView
      integrations={{ ...base, ...google, ...neon }}
      mcp={mcp}
      toolPolicies={toolPolicies}
    />
  );
}
