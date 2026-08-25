import { PluginDetail } from "@/components/PluginSettings";
import { SettingsContent } from "@/components/SettingsChrome";
import { currentUser } from "@/lib/auth";
import { getHeadlessPlugin } from "@/lib/headless-knowledge-server";

export default async function PluginDetailPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const [context, plugin] = await Promise.all([currentUser(), getHeadlessPlugin(name)]);
  if (!plugin) {
    return (
      <SettingsContent
        title="Plugin not found"
        description="This plugin may have been archived or never installed."
        backLink={{ href: "/settings/plugins", label: "Plugins" }}
      >
        <div />
      </SettingsContent>
    );
  }
  return <PluginDetail plugin={plugin} canEdit={context.role === "admin"} />;
}
