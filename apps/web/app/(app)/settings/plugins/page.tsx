import { PluginsSettings } from "@/components/PluginSettings";
import { currentUser } from "@/lib/auth";
import { listHeadlessPlugins } from "@/lib/headless-knowledge-server";

export default async function PluginsSettingsPage() {
  const [context, plugins] = await Promise.all([currentUser(), listHeadlessPlugins()]);
  return (
    <PluginsSettings
      plugins={plugins}
      canEdit={context.role === "admin"}
      workspaceId={context.workspace.id}
    />
  );
}
