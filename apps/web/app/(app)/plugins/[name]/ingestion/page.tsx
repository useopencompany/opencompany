import { AttioIntegrationSetup } from "@/components/AttioIntegrationSetup";
import { PageContent } from "@/components/PageContent";
import { FathomIngestionRoute } from "@/components/Routes";
import { currentUser } from "@/lib/auth";
import { getAttioIntegrationState } from "@/lib/integrations/attio";

// Attio and Fathom each expose an API-key connection, separate from the
// MCP account their plugin page connects. They hang off the plugin they belong to so the whole
// plugin surface stays in the main view.
export default async function PluginIngestionPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const normalizedName = name.toLocaleLowerCase();
  if (normalizedName === "attio") return <AttioIngestion />;
  if (normalizedName === "fathom") return <FathomIngestionRoute />;

  // Matches the plugin detail page: an unknown plugin surface keeps the reader in the app with a
  // way back, rather than dropping them on the global 404.
  return (
    <PageContent
      title="Ingestion not available"
      description="This plugin does not offer an API-key ingestion connection."
      backLink={{ href: `/plugins/${encodeURIComponent(name)}`, label: "Plugin" }}
    >
      <div />
    </PageContent>
  );
}

async function AttioIngestion() {
  const { user } = await currentUser();
  const state = await getAttioIntegrationState(user.workosUserId);

  return (
    <PageContent
      title="Attio ingestion"
      description="API-key connection"
      backLink={{ href: "/plugins/attio", label: "Attio plugin" }}
    >
      <AttioIntegrationSetup initialState={state} />
    </PageContent>
  );
}
