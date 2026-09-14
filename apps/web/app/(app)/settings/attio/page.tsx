import { AttioIntegrationSetup } from "@/components/AttioIntegrationSetup";
import { PageContent } from "@/components/PageContent";
import { currentUser } from "@/lib/auth";
import { getAttioIntegrationState } from "@/lib/integrations/attio";

// Attio's plugin page connects the MCP account for tools. This API-key connection is a separate
// integration that feeds Brain ingestion, so it keeps its own settings route.
export default async function AttioSettingsPage() {
  const { user } = await currentUser();
  const state = await getAttioIntegrationState(user.workosUserId);

  return (
    <PageContent
      title="Attio ingestion"
      description="API-key ingestion for Brain"
      backLink={{ href: "/plugins/attio", label: "Attio plugin" }}
    >
      <AttioIntegrationSetup initialState={state} />
    </PageContent>
  );
}
