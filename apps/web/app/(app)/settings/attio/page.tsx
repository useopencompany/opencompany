import { AttioIntegrationSetup } from "@/components/AttioIntegrationSetup";
import { SettingsContent } from "@/components/SettingsChrome";
import { currentUser } from "@/lib/auth";
import { getAttioIntegrationState } from "@/lib/integrations/attio";

export default async function AttioSettingsPage() {
  const { user } = await currentUser();
  const state = await getAttioIntegrationState(user.workosUserId);

  return (
    <SettingsContent
      title="Attio Wiki source"
      description="CRM activity ingestion for opencompany Wiki"
      backLink={{ href: "/wiki/sources", label: "Wiki sources" }}
    >
      <AttioIntegrationSetup initialState={state} brainSourcesHref="/wiki/sources" />
    </SettingsContent>
  );
}
