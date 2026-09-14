import { notFound } from "next/navigation";
import { AttioIntegrationSetup } from "@/components/AttioIntegrationSetup";
import { PageContent } from "@/components/PageContent";
import { FathomIngestionRoute } from "@/components/Routes";
import { currentUser } from "@/lib/auth";
import { getAttioIntegrationState } from "@/lib/integrations/attio";

// Attio and Fathom each expose an API-key connection that feeds Brain ingestion, separate from the
// MCP account their plugin page connects. They hang off the plugin they belong to so the whole
// plugin surface stays in the main view.
export default async function PluginIngestionPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  switch (name.toLocaleLowerCase()) {
    case "attio":
      return <AttioIngestion />;
    case "fathom":
      return <FathomIngestionRoute />;
    default:
      notFound();
  }
}

async function AttioIngestion() {
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
