import { CustomMcpPluginDetail } from "@/components/CustomMcpPluginSettings";
import { DopplerPluginDetail } from "@/components/DopplerPluginSettings";
import {
  AttioPluginDetail,
  BetterStackPluginDetail,
  ConvexPluginDetail,
  Dash0PluginDetail,
  FathomPluginDetail,
  GitHubPluginDetail,
  GmailPluginDetail,
  GoogleAdminPluginDetail,
  GoogleCalendarPluginDetail,
  GoogleDrivePluginDetail,
  GranolaPluginDetail,
  HubSpotPluginDetail,
  InfisicalPluginDetail,
  JamiePluginDetail,
  LatitudePluginDetail,
  LinearPluginDetail,
  NeonPluginDetail,
  NotionPluginDetail,
  type PluginLoadState,
  PostHogPluginDetail,
  RenderPluginDetail,
  ResendPluginDetail,
  SigNozPluginDetail,
  SlackPluginDetail,
  StripePluginDetail,
  SupabasePluginDetail,
  VercelPluginDetail,
  XPluginDetail,
} from "@/components/OfficialMcpPluginSettings";
import { OfficialSkillPluginDetail, PluginDetail } from "@/components/PluginSettings";
import { SettingsContent } from "@/components/SettingsChrome";
import { currentUser } from "@/lib/auth";
import { loadCurrentDopplerAuthSettings } from "@/lib/doppler-auth";
import { getHeadlessCustomMcp, getHeadlessPlugin } from "@/lib/headless-knowledge-server";
import {
  isOfficialMcpPluginName,
  isOfficialSkillPluginName,
  OFFICIAL_MCP_PLUGIN_METADATA,
  OFFICIAL_SKILL_PLUGIN_METADATA,
} from "@/lib/official-plugins";

export default async function PluginDetailPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const normalizedName = name.toLocaleLowerCase();
  if (normalizedName === "doppler") {
    const [, pluginState, settings] = await Promise.all([
      currentUser(),
      loadOfficialPlugin("doppler"),
      loadCurrentDopplerAuthSettings(),
    ]);
    return <DopplerPluginDetail pluginState={pluginState} settings={settings} />;
  }
  if (isOfficialMcpPluginName(normalizedName)) {
    const [, pluginState] = await Promise.all([currentUser(), loadOfficialPlugin(normalizedName)]);
    const Detail = {
      attio: AttioPluginDetail,
      betterstack: BetterStackPluginDetail,
      fathom: FathomPluginDetail,
      github: GitHubPluginDetail,
      gmail: GmailPluginDetail,
      granola: GranolaPluginDetail,
      "google-drive": GoogleDrivePluginDetail,
      "google-admin": GoogleAdminPluginDetail,
      "google-calendar": GoogleCalendarPluginDetail,
      hubspot: HubSpotPluginDetail,
      infisical: InfisicalPluginDetail,
      jamie: JamiePluginDetail,
      latitude: LatitudePluginDetail,
      linear: LinearPluginDetail,
      neon: NeonPluginDetail,
      notion: NotionPluginDetail,
      supabase: SupabasePluginDetail,
      resend: ResendPluginDetail,
      posthog: PostHogPluginDetail,
      convex: ConvexPluginDetail,
      render: RenderPluginDetail,
      signoz: SigNozPluginDetail,
      dash0: Dash0PluginDetail,
      slack: SlackPluginDetail,
      stripe: StripePluginDetail,
      vercel: VercelPluginDetail,
      x: XPluginDetail,
    }[normalizedName];
    return <Detail pluginState={pluginState} canEdit={true} />;
  }
  if (isOfficialSkillPluginName(normalizedName)) {
    const [, plugin] = await Promise.all([currentUser(), getHeadlessPlugin(normalizedName)]);
    const metadata = OFFICIAL_SKILL_PLUGIN_METADATA[normalizedName];
    return plugin ? (
      <PluginDetail
        plugin={plugin}
        canEdit={true}
        title={metadata.label}
        description={metadata.description}
        officialPluginName={normalizedName}
      />
    ) : (
      <OfficialSkillPluginDetail name={normalizedName} canEdit={true} />
    );
  }
  const [, plugin] = await Promise.all([currentUser(), getHeadlessPlugin(name)]);
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
  if (plugin.source.type === "custom_mcp") {
    return (
      <CustomMcpPluginDetail
        plugin={plugin}
        initialStatus={await getHeadlessCustomMcp(name)}
        canEdit={true}
      />
    );
  }
  return <PluginDetail plugin={plugin} canEdit={true} />;
}

async function loadOfficialPlugin(
  name: keyof typeof OFFICIAL_MCP_PLUGIN_METADATA | "doppler",
): Promise<PluginLoadState> {
  try {
    return { status: "ready", plugin: await getHeadlessPlugin(name) };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : `${name === "doppler" ? "Doppler" : OFFICIAL_MCP_PLUGIN_METADATA[name].label} plugin details could not be loaded.`,
    };
  }
}
