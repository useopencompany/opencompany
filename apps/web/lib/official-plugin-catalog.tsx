"use client";

// The official plugin catalog: shared metadata joined with the icon/colour
// treatment the UI renders, plus the install helpers built on it. Kept apart
// from PluginSettings so lighter surfaces (onboarding, zero states) can read
// the catalog without pulling in the full settings component tree.

import type { PluginImportPreviewDto } from "@opencompany/protocol";
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
import { SERVICE_MARKS, type ServiceMark } from "@/lib/service-marks";

export type OfficialPluginConfig = OfficialPluginMetadata & ServiceMark;
export type OfficialMcpPluginConfig = OfficialMcpPluginMetadata & ServiceMark;
export type OfficialSkillPluginConfig = OfficialSkillPluginMetadata & ServiceMark;
export type OfficialManagedPluginConfig = OfficialManagedPluginMetadata & ServiceMark;

export const OFFICIAL_MCP_PLUGINS = {
  attio: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.attio,
    ...SERVICE_MARKS.attio,
  },
  betterstack: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.betterstack,
    ...SERVICE_MARKS.betterstack,
  },
  fathom: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.fathom,
    ...SERVICE_MARKS.fathom,
  },
  github: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.github,
    ...SERVICE_MARKS.github,
  },
  gmail: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.gmail,
    ...SERVICE_MARKS.gmail,
  },
  granola: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.granola,
    ...SERVICE_MARKS.granola,
  },
  "google-admin": {
    ...OFFICIAL_MCP_PLUGIN_METADATA["google-admin"],
    ...SERVICE_MARKS["google-admin"],
  },
  "google-calendar": {
    ...OFFICIAL_MCP_PLUGIN_METADATA["google-calendar"],
    ...SERVICE_MARKS["google-calendar"],
  },
  "google-drive": {
    ...OFFICIAL_MCP_PLUGIN_METADATA["google-drive"],
    ...SERVICE_MARKS["google-drive"],
  },
  hubspot: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.hubspot,
    ...SERVICE_MARKS.hubspot,
  },
  infisical: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.infisical,
    ...SERVICE_MARKS.infisical,
  },
  jamie: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.jamie,
    ...SERVICE_MARKS.jamie,
  },
  latitude: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.latitude,
    ...SERVICE_MARKS.latitude,
  },
  linear: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.linear,
    ...SERVICE_MARKS.linear,
  },
  neon: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.neon,
    ...SERVICE_MARKS.neon,
  },
  notion: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.notion,
    ...SERVICE_MARKS.notion,
  },
  posthog: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.posthog,
    ...SERVICE_MARKS.posthog,
  },
  convex: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.convex,
    ...SERVICE_MARKS.convex,
  },
  render: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.render,
    ...SERVICE_MARKS.render,
  },
  vercel: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.vercel,
    ...SERVICE_MARKS.vercel,
  },
  supabase: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.supabase,
    ...SERVICE_MARKS.supabase,
  },
  todoist: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.todoist,
    ...SERVICE_MARKS.todoist,
  },
  resend: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.resend,
    ...SERVICE_MARKS.resend,
  },
  dash0: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.dash0,
    ...SERVICE_MARKS.dash0,
  },
  signoz: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.signoz,
    ...SERVICE_MARKS.signoz,
  },
  slack: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.slack,
    ...SERVICE_MARKS.slack,
  },
  stripe: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.stripe,
    ...SERVICE_MARKS.stripe,
  },
  x: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.x,
    ...SERVICE_MARKS.x,
  },
} as const satisfies Record<OfficialMcpPluginName, OfficialMcpPluginConfig>;

export const OFFICIAL_SKILL_PLUGINS = {
  doppler: {
    ...OFFICIAL_SKILL_PLUGIN_METADATA.doppler,
    ...SERVICE_MARKS.doppler,
  },
  "yc-advise": {
    ...OFFICIAL_SKILL_PLUGIN_METADATA["yc-advise"],
    ...SERVICE_MARKS["yc-advise"],
  },
} as const satisfies Record<OfficialSkillPluginName, OfficialSkillPluginConfig>;

export const OFFICIAL_MANAGED_PLUGINS = {
  "lead-research": {
    ...OFFICIAL_MANAGED_PLUGIN_METADATA["lead-research"],
    ...SERVICE_MARKS["lead-research"],
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
