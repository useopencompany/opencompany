"use client";

// The official plugin catalog: shared metadata joined with the icon/colour
// treatment the UI renders, plus the install helpers built on it. Kept apart
// from PluginSettings so lighter surfaces (onboarding, zero states) can read
// the catalog without pulling in the full settings component tree.

import type { PluginImportPreviewDto } from "@opencompany/protocol";
import {
  AttioIcon,
  BetterStackIcon,
  ConvexIcon,
  Dash0Icon,
  FathomIcon,
  GitHubIcon,
  GmailIcon,
  GoogleAdminIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  GranolaIcon,
  HubSpotIcon,
  InfisicalIcon,
  JamieIcon,
  LatitudeIcon,
  LinearIcon,
  NeonIcon,
  NotionIcon,
  PostHogIcon,
  RenderIcon,
  ResendIcon,
  SigNozIcon,
  SlackIcon,
  StripeIcon,
  SupabaseIcon,
  VercelIcon,
  XIcon,
} from "@opencompany/ui/icons";
import { Crosshair, KeyRound, Sparkles } from "lucide-react";
import {
  importHeadlessPlugin,
  previewHeadlessPluginImport,
} from "@/lib/headless-knowledge-commands";
import {
  OFFICIAL_MANAGED_PLUGIN_METADATA,
  OFFICIAL_MCP_PLUGIN_METADATA,
  OFFICIAL_SKILL_PLUGIN_METADATA,
  type OfficialManagedPluginMetadata,
  type OfficialManagedPluginName,
  type OfficialMcpPluginMetadata,
  type OfficialMcpPluginName,
  type OfficialPluginMetadata,
  type OfficialPluginName,
  type OfficialSkillPluginMetadata,
  type OfficialSkillPluginName,
} from "@/lib/official-plugins";

type OfficialPluginAppearance = {
  Icon: typeof LinearIcon;
  iconClassName: string;
};

export type OfficialPluginConfig = OfficialPluginMetadata & OfficialPluginAppearance;
export type OfficialMcpPluginConfig = OfficialMcpPluginMetadata & OfficialPluginAppearance;
export type OfficialSkillPluginConfig = OfficialSkillPluginMetadata & OfficialPluginAppearance;
export type OfficialManagedPluginConfig = OfficialManagedPluginMetadata & OfficialPluginAppearance;

export const OFFICIAL_MCP_PLUGINS = {
  attio: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.attio,
    Icon: AttioIcon,
    iconClassName: "bg-[#111111] text-white",
  },
  betterstack: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.betterstack,
    Icon: BetterStackIcon,
    iconClassName: "bg-[#1B1F23] text-white",
  },
  fathom: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.fathom,
    Icon: FathomIcon,
    iconClassName: "bg-[#101820] text-white",
  },
  github: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.github,
    Icon: GitHubIcon,
    iconClassName: "bg-[#181717] text-white",
  },
  gmail: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.gmail,
    Icon: GmailIcon,
    iconClassName: "bg-white text-[#EA4335]",
  },
  granola: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.granola,
    Icon: GranolaIcon,
    iconClassName: "bg-[#F0EBE1] text-[#1A1714]",
  },
  "google-admin": {
    ...OFFICIAL_MCP_PLUGIN_METADATA["google-admin"],
    Icon: GoogleAdminIcon,
    iconClassName: "bg-white",
  },
  "google-calendar": {
    ...OFFICIAL_MCP_PLUGIN_METADATA["google-calendar"],
    Icon: GoogleCalendarIcon,
    iconClassName: "bg-[#1A73E8] text-white",
  },
  "google-drive": {
    ...OFFICIAL_MCP_PLUGIN_METADATA["google-drive"],
    Icon: GoogleDriveIcon,
    iconClassName: "bg-white text-[#1FA463]",
  },
  hubspot: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.hubspot,
    Icon: HubSpotIcon,
    iconClassName: "bg-[#FF7A59] text-white",
  },
  infisical: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.infisical,
    Icon: InfisicalIcon,
    iconClassName: "bg-[#6C47FF] text-white",
  },
  jamie: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.jamie,
    Icon: JamieIcon,
    iconClassName: "bg-[#5B5BD6] text-white",
  },
  latitude: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.latitude,
    Icon: LatitudeIcon,
    iconClassName: "bg-[#171717] text-white",
  },
  linear: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.linear,
    Icon: LinearIcon,
    iconClassName: "bg-[#5E6AD2] text-white",
  },
  neon: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.neon,
    Icon: NeonIcon,
    iconClassName: "bg-[#00E599] text-[#0B0F14]",
  },
  notion: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.notion,
    Icon: NotionIcon,
    iconClassName: "bg-white text-black",
  },
  posthog: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.posthog,
    Icon: PostHogIcon,
    iconClassName: "bg-[#F54E00] text-white",
  },
  convex: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.convex,
    Icon: ConvexIcon,
    iconClassName: "bg-surface-muted",
  },
  render: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.render,
    Icon: RenderIcon,
    iconClassName: "bg-[#0B0D0E] text-white",
  },
  vercel: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.vercel,
    Icon: VercelIcon,
    iconClassName: "bg-black text-white",
  },
  supabase: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.supabase,
    Icon: SupabaseIcon,
    iconClassName: "bg-[#003D2B] text-[#3ECF8E]",
  },
  resend: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.resend,
    Icon: ResendIcon,
    iconClassName: "bg-black text-white",
  },
  dash0: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.dash0,
    Icon: Dash0Icon,
    iconClassName: "bg-background",
  },
  signoz: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.signoz,
    Icon: SigNozIcon,
    iconClassName: "bg-[#0B0D0E] text-white",
  },
  slack: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.slack,
    Icon: SlackIcon,
    iconClassName: "bg-white text-[#4A154B]",
  },
  stripe: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.stripe,
    Icon: StripeIcon,
    iconClassName: "bg-[#635BFF] text-white",
  },
  x: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.x,
    Icon: XIcon,
    iconClassName: "bg-black text-white",
  },
} as const satisfies Record<OfficialMcpPluginName, OfficialMcpPluginConfig>;

export const OFFICIAL_SKILL_PLUGINS = {
  doppler: {
    ...OFFICIAL_SKILL_PLUGIN_METADATA.doppler,
    Icon: KeyRound,
    iconClassName: "bg-[#FF6100] text-white",
  },
  "yc-advise": {
    ...OFFICIAL_SKILL_PLUGIN_METADATA["yc-advise"],
    Icon: Sparkles,
    iconClassName: "bg-[#F26522] text-white",
  },
} as const satisfies Record<OfficialSkillPluginName, OfficialSkillPluginConfig>;

export const OFFICIAL_MANAGED_PLUGINS = {
  "lead-research": {
    ...OFFICIAL_MANAGED_PLUGIN_METADATA["lead-research"],
    Icon: Crosshair,
    iconClassName: "bg-[#1F6FEB] text-white",
  },
} as const satisfies Record<OfficialManagedPluginName, OfficialManagedPluginConfig>;

export const OFFICIAL_PLUGINS = {
  ...OFFICIAL_MCP_PLUGINS,
  ...OFFICIAL_SKILL_PLUGINS,
  ...OFFICIAL_MANAGED_PLUGINS,
} as const satisfies Record<OfficialPluginName, OfficialPluginConfig>;

export const GITHUB_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.github.name;
export const GITHUB_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.github.source;
export const GMAIL_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.gmail.name;
export const GMAIL_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.gmail.source;
export const GRANOLA_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.granola.name;
export const GRANOLA_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.granola.source;
export const GOOGLE_CALENDAR_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS["google-calendar"].name;
export const GOOGLE_CALENDAR_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS["google-calendar"].source;
export const GOOGLE_DRIVE_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS["google-drive"].name;
export const GOOGLE_DRIVE_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS["google-drive"].source;
export const HUBSPOT_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.hubspot.name;
export const HUBSPOT_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.hubspot.source;
export const INFISICAL_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.infisical.name;
export const INFISICAL_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.infisical.source;
export const JAMIE_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.jamie.name;
export const JAMIE_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.jamie.source;
export const ATTIO_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.attio.name;
export const ATTIO_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.attio.source;
export const LATITUDE_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.latitude.name;
export const LATITUDE_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.latitude.source;
export const LINEAR_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.linear.name;
export const LINEAR_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.linear.source;
export const NEON_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.neon.name;
export const NEON_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.neon.source;
export const NOTION_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.notion.name;
export const NOTION_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.notion.source;
export const POSTHOG_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.posthog.name;
export const POSTHOG_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.posthog.source;
export const RENDER_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.render.name;
export const RENDER_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.render.source;
export const VERCEL_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.vercel.name;
export const VERCEL_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.vercel.source;
export const BETTERSTACK_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.betterstack.name;
export const BETTERSTACK_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.betterstack.source;
export const FATHOM_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.fathom.name;
export const FATHOM_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.fathom.source;
export const SIGNOZ_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.signoz.name;
export const SIGNOZ_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.signoz.source;
export const SLACK_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.slack.name;
export const SLACK_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.slack.source;
export const STRIPE_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.stripe.name;
export const STRIPE_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.stripe.source;
export const X_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.x.name;
export const X_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.x.source;
export const YC_ADVISE_PLUGIN_NAME = OFFICIAL_SKILL_PLUGINS["yc-advise"].name;
export const YC_ADVISE_PLUGIN_SOURCE = OFFICIAL_SKILL_PLUGINS["yc-advise"].source;

export async function installOfficialPlugin(
  config: OfficialPluginConfig,
  preview?: PluginImportPreviewDto,
) {
  const confirmed = preview ?? (await previewHeadlessPluginImport({ url: config.source }));
  if (confirmed.manifest.name.toLocaleLowerCase() !== config.name) {
    throw new Error(
      `Expected the ${config.name} plugin, but this source contains ${confirmed.manifest.name}.`,
    );
  }
  const result = await importHeadlessPlugin({
    url: config.source,
    expectedResolvedCommit: confirmed.source.resolvedCommit,
    expectedIntegrity: confirmed.integrity,
  });
  return result.plugin;
}

export function installOfficialMcpPlugin(
  config: OfficialMcpPluginConfig,
  preview?: PluginImportPreviewDto,
) {
  return installOfficialPlugin(config, preview);
}

export function installOfficialLinearPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.linear, preview);
}

export function installOfficialGitHubPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.github, preview);
}

export function installOfficialGmailPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.gmail, preview);
}

export function installOfficialGoogleCalendarPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS["google-calendar"], preview);
}

export function installOfficialGoogleDrivePlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS["google-drive"], preview);
}

export function installOfficialHubSpotPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.hubspot, preview);
}

export function installOfficialAttioPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.attio, preview);
}

export function installOfficialLatitudePlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.latitude, preview);
}

export function installOfficialNeonPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.neon, preview);
}

export function installOfficialBetterStackPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.betterstack, preview);
}

export function installOfficialPostHogPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.posthog, preview);
}

export function installOfficialSigNozPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.signoz, preview);
}

export function installOfficialSlackPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.slack, preview);
}

export function installOfficialStripePlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.stripe, preview);
}
