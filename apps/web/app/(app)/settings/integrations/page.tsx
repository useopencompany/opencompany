import { IntegrationsSettingsRoute } from "@/components/Routes";
import { browserProfilesAvailable } from "@/lib/browser-profiles";
import { listHeadlessPlugins } from "@/lib/headless-knowledge-server";

export default async function IntegrationsSettingsPage() {
  const plugins = await listHeadlessPlugins().catch(() => []);
  const slackPluginInstalled = plugins.some(
    (plugin) => plugin.name.toLocaleLowerCase() === "slack",
  );
  return (
    <IntegrationsSettingsRoute
      browserProfilesEnabled={browserProfilesAvailable()}
      slackPluginInstalled={slackPluginInstalled}
    />
  );
}
