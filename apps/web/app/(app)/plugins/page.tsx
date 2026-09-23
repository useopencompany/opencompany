import { CompanyPluginsRoute } from "@/components/CompanyPluginSettings";
import { PluginsRoute } from "@/components/PluginSettings";
import { currentUser } from "@/lib/auth";
import { getCompanyGitHubPluginAction } from "@/lib/company-plugin-actions";
import { loadCurrentDopplerAuthSettings } from "@/lib/doppler-auth";
import { listHeadlessPlugins } from "@/lib/headless-knowledge-server";

export default async function PluginsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const [context, params] = await Promise.all([currentUser(), searchParams]);
  // Company plugins are managed by admins; members keep the personal catalog they had before.
  const isAdmin = context.role === "admin";
  if (isAdmin && params.scope === "company") {
    return <CompanyPluginsRoute github={await getCompanyGitHubPluginAction()} />;
  }

  const plugins = await listHeadlessPlugins();
  const doppler = plugins.some((plugin) => plugin.name === "doppler" && plugin.status === "enabled")
    ? await loadCurrentDopplerAuthSettings()
    : null;
  return (
    <PluginsRoute
      plugins={plugins}
      canEdit={true}
      workspaceId={context.workspace.id}
      dopplerConnected={doppler?.status === "connected"}
      showScopeTabs={isAdmin}
    />
  );
}
