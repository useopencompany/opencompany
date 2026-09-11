import { OFFICIAL_PLUGIN_SOURCES } from "@opencompany/agent-runtime/official-plugin-catalog";

export type OfficialMcpPluginName =
  | "attio"
  | "betterstack"
  | "fathom"
  | "github"
  | "gmail"
  | "granola"
  | "google-admin"
  | "google-calendar"
  | "google-drive"
  | "hubspot"
  | "infisical"
  | "jamie"
  | "latitude"
  | "linear"
  | "neon"
  | "notion"
  | "supabase"
  | "resend"
  | "posthog"
  | "convex"
  | "render"
  | "vercel"
  | "signoz"
  | "slack"
  | "stripe"
  | "x";
export type OfficialSkillPluginName = "yc-advise";
export type OfficialPluginName = OfficialMcpPluginName | OfficialSkillPluginName;
export type OfficialPluginCategory = "communication" | "productivity" | "engineering" | "business";

export const OFFICIAL_PLUGIN_CATEGORIES = {
  communication: "Communication",
  productivity: "Productivity",
  engineering: "Engineering",
  business: "Business",
} as const satisfies Record<OfficialPluginCategory, string>;

type OfficialPluginMetadataBase = {
  name: OfficialPluginName;
  label: string;
  description: string;
  source: string;
  category: OfficialPluginCategory;
  featured?: boolean;
};

export type OfficialMcpPluginMetadata = OfficialPluginMetadataBase & {
  name: OfficialMcpPluginName;
  kind: "mcp";
  connectionProvider:
    | "attio"
    | "betterstack"
    | "fathom"
    | "github_user"
    | "gmail"
    | "granola"
    | "google_admin"
    | "google_calendar"
    | "google_drive"
    | "hubspot"
    | "infisical"
    | "jamie"
    | "latitude"
    | "linear"
    | "neon"
    | "notion"
    | "supabase"
    | "resend"
    | "posthog"
    | "convex"
    | "render"
    | "vercel"
    | "signoz"
    | "slack"
    | "stripe"
    | "x_account";
  connectHref: string;
  connectionUnavailableReason?: string;
  accountLabel?: string;
  accountDescription: string;
  ingestionHref?: string;
  ingestionLabel?: string;
  // Where to send someone who enabled a plugin event but has no account it can bind to. Defaults
  // to the plugin page; set it when the event's connection is not the one that page connects.
  eventAccountHref?: string;
  eventAccountLabel?: string;
};

export type OfficialSkillPluginMetadata = OfficialPluginMetadataBase & {
  name: OfficialSkillPluginName;
  kind: "skills";
};

export type OfficialPluginMetadata = OfficialMcpPluginMetadata | OfficialSkillPluginMetadata;

const OFFICIAL_PLUGIN_SOURCE_PATTERN =
  /^https:\/\/github\.com\/useopencompany\/plugins\/tree\/([0-9a-f]{40})(?:\/|$)/u;

export function officialPluginUpdateAvailable(
  installedCommit: string,
  officialSource: string,
): boolean {
  const expectedCommit = OFFICIAL_PLUGIN_SOURCE_PATTERN.exec(officialSource)?.[1];
  return expectedCommit !== undefined && installedCommit !== expectedCommit;
}

// The public repository is the reviewed trust boundary. Keep every source pinned to a full commit.
export const OFFICIAL_MCP_PLUGIN_METADATA = {
  attio: {
    name: "attio",
    kind: "mcp",
    label: "Attio",
    description: "Inspect CRM structure, query workspace data, and make approved changes.",
    category: "business",
    source: OFFICIAL_PLUGIN_SOURCES["attio"],
    connectionProvider: "attio",
    connectHref: "/api/integrations/attio-mcp/start?returnTo=/settings/plugins/attio",
    accountDescription: "The Attio account opencompany uses when you run CRM tools.",
    ingestionHref: "/wiki/sources",
    ingestionLabel: "Configure Attio ingestion in Wiki sources",
  },
  betterstack: {
    name: "betterstack",
    kind: "mcp",
    label: "Better Stack",
    description:
      "Investigate observability data and manage monitoring, incidents, dashboards, and team access.",
    category: "engineering",
    source: OFFICIAL_PLUGIN_SOURCES["betterstack"],
    connectionProvider: "betterstack",
    connectHref: "/api/integrations/betterstack/start?returnTo=/settings/plugins/betterstack",
    accountDescription: "The account opencompany uses when you run Better Stack tools.",
  },
  fathom: {
    name: "fathom",
    kind: "mcp",
    label: "Fathom",
    description: "Search meetings and read summaries, transcripts, and action items with approval.",
    category: "productivity",
    source: OFFICIAL_PLUGIN_SOURCES["fathom"],
    connectionProvider: "fathom",
    connectHref: "/api/integrations/fathom-mcp/start?returnTo=/settings/plugins/fathom",
    accountDescription: "The Fathom account opencompany uses when you search meeting content.",
    ingestionHref: "/wiki/sources",
    ingestionLabel: "Configure legacy Fathom ingestion in Wiki sources",
  },
  github: {
    name: "github",
    kind: "mcp",
    label: "GitHub as you",
    description: "Work with repositories, issues, pull requests, and Actions as yourself.",
    category: "engineering",
    featured: true,
    source: OFFICIAL_PLUGIN_SOURCES["github"],
    connectionProvider: "github_user",
    connectHref: "/api/integrations/github-user/start?returnTo=/settings/plugins/github",
    accountLabel: "GitHub",
    accountDescription: "The personal GitHub account opencompany uses when it works as you.",
  },
  gmail: {
    name: "gmail",
    kind: "mcp",
    label: "Gmail",
    description:
      "Search and read Gmail, download attachments, create drafts, and organize messages with approval.",
    category: "communication",
    featured: true,
    source: OFFICIAL_PLUGIN_SOURCES["gmail"],
    connectionProvider: "gmail",
    connectHref: "/api/integrations/gmail/start?access=mcp&returnTo=/settings/plugins/gmail",
    accountDescription: "The most recently connected Gmail account powers Gmail tools.",
    ingestionHref: "/wiki/sources",
    ingestionLabel: "Configure Gmail ingestion in Wiki sources",
  },
  granola: {
    name: "granola",
    kind: "mcp",
    label: "Granola",
    description: "Search and read meeting notes, summaries, folders, and transcripts.",
    category: "productivity",
    source: OFFICIAL_PLUGIN_SOURCES["granola"],
    connectionProvider: "granola",
    connectHref: "/api/integrations/granola-mcp/start?returnTo=/settings/plugins/granola",
    accountDescription: "The Granola account opencompany uses when you search meeting history.",
    ingestionHref: "/wiki/sources",
    ingestionLabel: "Configure legacy Granola API ingestion in Wiki sources",
    // Granola's note events are discovered by polling its REST API, which the MCP OAuth connection
    // cannot call. They bind to the personal `grn_` API key connected from Wiki sources.
    eventAccountHref: "/wiki/sources",
    eventAccountLabel: "Add a Granola API key",
  },
  "google-admin": {
    name: "google-admin",
    kind: "mcp",
    label: "Google Admin",
    description: "Create Workspace user accounts, set up groups, and add group members.",
    category: "productivity",
    source: OFFICIAL_PLUGIN_SOURCES["google-admin"],
    connectionProvider: "google_admin",
    connectHref: "/api/integrations/google-admin/start?returnTo=/settings/plugins/google-admin",
    accountDescription:
      "Connect a Google Workspace administrator with user and group management privileges. The most recently connected account powers these tools. New users need a password reset and sign-in details from Google Admin.",
  },
  "google-calendar": {
    name: "google-calendar",
    kind: "mcp",
    label: "Google Calendar",
    description: "List calendars, read your schedule, and create calendar events.",
    category: "productivity",
    source: OFFICIAL_PLUGIN_SOURCES["google-calendar"],
    connectionProvider: "google_calendar",
    connectHref:
      "/api/integrations/google-calendar/start?returnTo=/settings/plugins/google-calendar",
    accountDescription: "The Google account opencompany uses when you run Calendar tools.",
  },
  "google-drive": {
    name: "google-drive",
    kind: "mcp",
    label: "Google Drive",
    description:
      "Browse, read, create, copy, and edit files through opencompany's Google Drive MCP.",
    category: "productivity",
    source: OFFICIAL_PLUGIN_SOURCES["google-drive"],
    connectionProvider: "google_drive",
    connectHref: "/api/integrations/google-drive/start?returnTo=/settings/plugins/google-drive",
    accountDescription:
      "The most recently connected Google Drive account powers plugin tools. Other accounts remain available for Wiki ingestion.",
    ingestionHref: "/wiki/sources",
    ingestionLabel: "Configure Google Drive ingestion in Wiki sources",
  },
  hubspot: {
    name: "hubspot",
    kind: "mcp",
    label: "HubSpot",
    description: "Inspect CRM structure, query customer data, and make approved changes.",
    category: "business",
    source: OFFICIAL_PLUGIN_SOURCES["hubspot"],
    connectionProvider: "hubspot",
    connectHref: "/api/integrations/hubspot-mcp/start?returnTo=/settings/plugins/hubspot",
    accountDescription: "The HubSpot account opencompany uses when you run CRM tools.",
    ingestionHref: "/wiki/sources",
    ingestionLabel: "Configure HubSpot ingestion in Wiki sources",
  },
  infisical: {
    name: "infisical",
    kind: "mcp",
    label: "Infisical",
    description:
      "Search current Infisical documentation and safely use workspace secrets in coding sandboxes.",
    category: "engineering",
    source: OFFICIAL_PLUGIN_SOURCES["infisical"],
    connectionProvider: "infisical",
    connectHref: "/settings/plugins/infisical",
    accountDescription:
      "Your personal Infisical login, restored into your coding sandboxes. Its credentials are never sent to the documentation MCP.",
  },
  jamie: {
    name: "jamie",
    kind: "mcp",
    label: "Jamie",
    description:
      "Search meeting notes and transcripts, review action items, and organize meetings with approval.",
    category: "productivity",
    source: OFFICIAL_PLUGIN_SOURCES["jamie"],
    connectionProvider: "jamie",
    connectHref: "/api/integrations/jamie-mcp/start?returnTo=/settings/plugins/jamie",
    accountDescription: "The Jamie account opencompany uses when you run meeting tools.",
  },
  latitude: {
    name: "latitude",
    kind: "mcp",
    label: "Latitude",
    description:
      "Inspect agent observability data and manage Latitude workspace resources with approval.",
    category: "engineering",
    source: OFFICIAL_PLUGIN_SOURCES["latitude"],
    connectionProvider: "latitude",
    connectHref: "/api/integrations/latitude/start?returnTo=/settings/plugins/latitude",
    accountDescription: "The Latitude account opencompany uses when you run observability tools.",
  },
  linear: {
    name: "linear",
    kind: "mcp",
    label: "Linear",
    description: "Work with Linear issues, projects, comments, and team workflows.",
    category: "productivity",
    featured: true,
    source: OFFICIAL_PLUGIN_SOURCES["linear"],
    connectionProvider: "linear",
    connectHref: "/api/integrations/linear/start?returnTo=/settings/plugins/linear",
    accountDescription: "The account opencompany uses when you run Linear tools.",
    ingestionHref: "/wiki/sources",
    ingestionLabel: "Configure Linear ingestion in Wiki sources",
  },
  neon: {
    name: "neon",
    kind: "mcp",
    label: "Neon",
    description:
      "Inspect Neon projects and database structure, and run permission-gated read-only SQL.",
    category: "engineering",
    source: OFFICIAL_PLUGIN_SOURCES["neon"],
    connectionProvider: "neon",
    connectHref: "/api/integrations/neon/start?returnTo=/settings/plugins/neon",
    accountDescription: "The account opencompany uses when you run Neon tools.",
  },
  notion: {
    name: "notion",
    kind: "mcp",
    label: "Notion",
    description:
      "Search workspace knowledge, work with Custom Agents, and make approved content changes.",
    category: "productivity",
    featured: true,
    source: OFFICIAL_PLUGIN_SOURCES["notion"],
    connectionProvider: "notion",
    connectHref: "/api/integrations/notion/start?returnTo=/settings/plugins/notion",
    accountDescription: "The Notion account opencompany uses when you work with workspace content.",
  },
  supabase: {
    name: "supabase",
    kind: "mcp",
    label: "Supabase",
    description:
      "Inspect projects, query databases, and manage migrations and Edge Functions with permission controls.",
    category: "engineering",
    source: OFFICIAL_PLUGIN_SOURCES["supabase"],
    connectionProvider: "supabase",
    connectHref: "/api/integrations/supabase/start?returnTo=/settings/plugins/supabase",
    accountDescription:
      "Choose the Supabase organization to authorize. SQL can read or change data; review permissions before use.",
  },
  resend: {
    name: "resend",
    kind: "mcp",
    label: "Resend",
    description:
      "Send emails, read inbound messages, and manage contacts and broadcasts with permission controls.",
    category: "communication",
    source: OFFICIAL_PLUGIN_SOURCES["resend"],
    connectionProvider: "resend",
    connectHref: "/api/integrations/resend/start?returnTo=/settings/plugins/resend",
    accountDescription:
      "Connect your Resend account. Sending and sensitive reads require approval; access administration and destructive actions start off.",
  },
  posthog: {
    name: "posthog",
    kind: "mcp",
    label: "PostHog",
    description:
      "Explore dashboards, insights, schemas, and product analytics, with permission-gated insight creation.",
    category: "business",
    source: OFFICIAL_PLUGIN_SOURCES["posthog"],
    connectionProvider: "posthog",
    connectHref: "/api/integrations/posthog/start?returnTo=/settings/plugins/posthog",
    accountDescription: "The PostHog account opencompany uses when you run analytics tools.",
  },
  convex: {
    name: "convex",
    kind: "mcp",
    label: "Convex",
    category: "engineering",
    description:
      "Inspect deployments, query data, and run Convex functions with permission controls.",
    source: OFFICIAL_PLUGIN_SOURCES.convex,
    connectionProvider: "convex",
    connectHref: "/settings/plugins/convex#convex-deploy-key",
    accountDescription:
      "A deployment-scoped key connects one Convex deployment. Production supports schema and function inspection only.",
  },
  render: {
    name: "render",
    kind: "mcp",
    label: "Render",
    description:
      "Inspect Render infrastructure, troubleshoot services, and deploy permission-gated applications and datastores.",
    category: "engineering",
    source: OFFICIAL_PLUGIN_SOURCES["render"],
    connectionProvider: "render",
    connectHref: "/settings/plugins/render#render-api-key",
    accountDescription: "The Render account opencompany uses when you run Render tools.",
  },
  vercel: {
    name: "vercel",
    kind: "mcp",
    label: "Vercel",
    description:
      "Inspect Vercel projects and deployments, investigate operational data, and perform permission-gated deployment and account actions.",
    category: "engineering",
    source: OFFICIAL_PLUGIN_SOURCES["vercel"],
    connectionProvider: "vercel",
    connectHref: "/api/integrations/vercel/start?returnTo=/settings/plugins/vercel",
    connectionUnavailableReason:
      "Vercel requires MCP clients and their production callback URLs to be approved before they can connect. opencompany is awaiting that approval.",
    accountDescription: "The account opencompany uses when you run Vercel tools.",
  },
  signoz: {
    name: "signoz",
    kind: "mcp",
    label: "SigNoz",
    description: "Investigate logs, metrics, traces, alerts, and dashboards in SigNoz US Cloud.",
    category: "engineering",
    source: OFFICIAL_PLUGIN_SOURCES["signoz"],
    connectionProvider: "signoz",
    connectHref: "/api/integrations/signoz/start?returnTo=/settings/plugins/signoz",
    accountDescription: "The SigNoz US Cloud account opencompany uses when you run SigNoz tools.",
  },
  slack: {
    name: "slack",
    kind: "mcp",
    label: "Slack",
    description: "Search Slack and, with approval, read private content or make changes.",
    category: "communication",
    featured: true,
    source: OFFICIAL_PLUGIN_SOURCES["slack"],
    connectionProvider: "slack",
    connectHref: "/api/integrations/slack/start?returnTo=/settings/plugins/slack",
    accountDescription: "The most recently connected Slack account powers Slack tools.",
  },
  stripe: {
    name: "stripe",
    kind: "mcp",
    label: "Stripe",
    description:
      "Learn about Stripe, inspect account and financial data, and manage Stripe resources with approval.",
    category: "business",
    source: OFFICIAL_PLUGIN_SOURCES["stripe"],
    connectionProvider: "stripe",
    connectHref: "/api/integrations/stripe/start?returnTo=/settings/plugins/stripe",
    accountDescription: "Connect your Stripe account securely through Stripe. No API key required.",
  },
  x: {
    name: "x",
    kind: "mcp",
    label: "X",
    description: "Research public conversations and manage your X account with approval.",
    category: "communication",
    source: OFFICIAL_PLUGIN_SOURCES["x"],
    connectionProvider: "x_account",
    connectHref: "/api/integrations/x-account/start?returnTo=/settings/plugins/x",
    accountLabel: "X",
    accountDescription:
      "The most recently connected X account powers plugin tools. Other connected X accounts remain available if the plugin is uninstalled.",
  },
} as const satisfies Record<OfficialMcpPluginName, OfficialMcpPluginMetadata>;

export const OFFICIAL_SKILL_PLUGIN_METADATA = {
  "yc-advise": {
    name: "yc-advise",
    kind: "skills",
    label: "YC Advise",
    description:
      "Independent YC-style startup advice and structured founder office hours, based on public principles and not affiliated with Y Combinator.",
    category: "business",
    source: OFFICIAL_PLUGIN_SOURCES["yc-advise"],
  },
} as const satisfies Record<OfficialSkillPluginName, OfficialSkillPluginMetadata>;

export function isOfficialMcpPluginName(value: string): value is OfficialMcpPluginName {
  return value === value.toLocaleLowerCase() && Object.hasOwn(OFFICIAL_MCP_PLUGIN_METADATA, value);
}

export function isOfficialSkillPluginName(value: string): value is OfficialSkillPluginName {
  return (
    value === value.toLocaleLowerCase() && Object.hasOwn(OFFICIAL_SKILL_PLUGIN_METADATA, value)
  );
}
