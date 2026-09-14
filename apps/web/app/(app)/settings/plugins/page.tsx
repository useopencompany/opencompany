import { PluginsSettings } from "@/components/PluginSettings";
import { currentUser } from "@/lib/auth";
import { loadCurrentDopplerAuthSettings } from "@/lib/doppler-auth";
import { listHeadlessPlugins } from "@/lib/headless-knowledge-server";

export default async function PluginsSettingsPage() {
  const [context, plugins] = await Promise.all([currentUser(), listHeadlessPlugins()]);
  const doppler = plugins.some((plugin) => plugin.name === "doppler" && plugin.status === "enabled")
    ? await loadCurrentDopplerAuthSettings()
    : null;
  return (
    <PluginsSettings
      plugins={plugins}
      canEdit={true}
      workspaceId={context.workspace.id}
      dopplerConnected={doppler?.status === "connected"}
    />
  );
}
