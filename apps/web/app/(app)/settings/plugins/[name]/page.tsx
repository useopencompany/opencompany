import {
  BetterStackPluginDetail,
  GitHubPluginDetail,
  GoogleCalendarPluginDetail,
  LinearPluginDetail,
  NeonPluginDetail,
  type PluginLoadState,
  SlackPluginDetail,
} from "@/components/OfficialMcpPluginSettings";
import { PluginDetail } from "@/components/PluginSettings";
import { SettingsContent } from "@/components/SettingsChrome";
import { currentUser } from "@/lib/auth";
import { getHeadlessPlugin } from "@/lib/headless-knowledge-server";
import { isOfficialMcpPluginName, OFFICIAL_MCP_PLUGIN_METADATA } from "@/lib/official-mcp-plugins";

export default async function PluginDetailPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const normalizedName = name.toLocaleLowerCase();
  if (isOfficialMcpPluginName(normalizedName)) {
    const [context, pluginState] = await Promise.all([
      currentUser(),
      loadOfficialPlugin(normalizedName),
    ]);
    const Detail = {
      betterstack: BetterStackPluginDetail,
      github: GitHubPluginDetail,
      "google-calendar": GoogleCalendarPluginDetail,
      linear: LinearPluginDetail,
      neon: NeonPluginDetail,
      slack: SlackPluginDetail,
    }[normalizedName];
    return <Detail pluginState={pluginState} canEdit={context.role === "admin"} />;
  }
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

async function loadOfficialPlugin(
  name: keyof typeof OFFICIAL_MCP_PLUGIN_METADATA,
): Promise<PluginLoadState> {
  try {
    return { status: "ready", plugin: await getHeadlessPlugin(name) };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : `${OFFICIAL_MCP_PLUGIN_METADATA[name].label} plugin details could not be loaded.`,
    };
  }
}
