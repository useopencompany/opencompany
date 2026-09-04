import {
  BetterStackPluginDetail,
  GitHubPluginDetail,
  GmailPluginDetail,
  GoogleCalendarPluginDetail,
  GoogleDrivePluginDetail,
  GranolaPluginDetail,
  HubSpotPluginDetail,
  LatitudePluginDetail,
  LinearPluginDetail,
  NeonPluginDetail,
  type PluginLoadState,
  PostHogPluginDetail,
  RenderPluginDetail,
  SigNozPluginDetail,
  SlackPluginDetail,
  StripePluginDetail,
  XPluginDetail,
} from "@/components/OfficialMcpPluginSettings";
import { OfficialSkillPluginDetail, PluginDetail } from "@/components/PluginSettings";
import { SettingsContent } from "@/components/SettingsChrome";
import { currentUser } from "@/lib/auth";
import { getHeadlessPlugin } from "@/lib/headless-knowledge-server";
import {
  isOfficialMcpPluginName,
  isOfficialSkillPluginName,
  OFFICIAL_MCP_PLUGIN_METADATA,
  OFFICIAL_SKILL_PLUGIN_METADATA,
} from "@/lib/official-plugins";

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
      gmail: GmailPluginDetail,
      granola: GranolaPluginDetail,
      "google-drive": GoogleDrivePluginDetail,
      "google-calendar": GoogleCalendarPluginDetail,
      hubspot: HubSpotPluginDetail,
      latitude: LatitudePluginDetail,
      linear: LinearPluginDetail,
      neon: NeonPluginDetail,
      posthog: PostHogPluginDetail,
      render: RenderPluginDetail,
      signoz: SigNozPluginDetail,
      slack: SlackPluginDetail,
      stripe: StripePluginDetail,
      x: XPluginDetail,
    }[normalizedName];
    return <Detail pluginState={pluginState} canEdit={context.role === "admin"} />;
  }
  if (isOfficialSkillPluginName(normalizedName)) {
    const [context, plugin] = await Promise.all([currentUser(), getHeadlessPlugin(normalizedName)]);
    const metadata = OFFICIAL_SKILL_PLUGIN_METADATA[normalizedName];
    return plugin ? (
      <PluginDetail
        plugin={plugin}
        canEdit={context.role === "admin"}
        title={metadata.label}
        description={metadata.description}
      />
    ) : (
      <OfficialSkillPluginDetail name={normalizedName} canEdit={context.role === "admin"} />
    );
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
