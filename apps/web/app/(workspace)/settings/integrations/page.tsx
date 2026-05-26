import IntegrationsView from "@/components/IntegrationsView";
import { loadWorkspaceIntegrationState } from "@/lib/integrations/actions";

export default async function IntegrationsPage() {
  const integrations = await loadWorkspaceIntegrationState();

  return <IntegrationsView integrations={integrations} />;
}
