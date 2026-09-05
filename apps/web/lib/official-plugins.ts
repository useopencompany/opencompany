export type OfficialMcpPluginName =
  | "attio"
  | "betterstack"
  | "fathom"
  | "github"
  | "gmail"
  | "granola"
  | "google-calendar"
  | "google-drive"
  | "hubspot"
  | "infisical"
  | "jamie"
  | "latitude"
  | "linear"
  | "neon"
  | "posthog"
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
    | "google_calendar"
    | "google_drive"
    | "hubspot"
    | "infisical"
    | "jamie"
    | "latitude"
    | "linear"
    | "neon"
    | "posthog"
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
};

export type OfficialSkillPluginMetadata = OfficialPluginMetadataBase & {
  name: OfficialSkillPluginName;
  kind: "skills";
};

export type OfficialPluginMetadata = OfficialMcpPluginMetadata | OfficialSkillPluginMetadata;

// The public repository is the reviewed trust boundary. Keep every source pinned to a full commit.
export const OFFICIAL_MCP_PLUGIN_METADATA = {
  attio: {
    name: "attio",
    kind: "mcp",
    label: "Attio",
    description: "Inspect CRM structure, query workspace data, and make approved changes.",
    category: "business",
    source:
      "https://github.com/useopencompany/plugins/tree/0daeec4cff5d5f9925af2901410e1aa6c8baf0d8/attio",
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
    source:
      "https://github.com/useopencompany/plugins/tree/cd2ab3510ce35031bb564fbd2d4d55b825a4a83b/betterstack",
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
    source:
      "https://github.com/useopencompany/plugins/tree/444dd4dbfaaed6abd2c7c8000024c5be0ff4fa48/fathom",
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
    source:
      "https://github.com/useopencompany/plugins/tree/232e380e8850c440c28e4588ef79143d41c000db/github",
    connectionProvider: "github_user",
    connectHref: "/api/integrations/github-user/start?returnTo=/settings/plugins/github",
    accountLabel: "GitHub",
    accountDescription: "The personal GitHub account opencompany uses when it works as you.",
  },
  gmail: {
    name: "gmail",
    kind: "mcp",
    label: "Gmail",
    description: "Search and read Gmail, create drafts, and organize messages with approval.",
    category: "communication",
    featured: true,
    source:
      "https://github.com/useopencompany/plugins/tree/587fb06ae2a4e4bed7532e216f8712979ca35e7b/gmail",
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
    source:
      "https://github.com/useopencompany/plugins/tree/cf036c82fc5186f5187e4da59b040ce92e492df3/granola",
    connectionProvider: "granola",
    connectHref: "/api/integrations/granola-mcp/start?returnTo=/settings/plugins/granola",
    accountDescription: "The Granola account opencompany uses when you search meeting history.",
    ingestionHref: "/wiki/sources",
    ingestionLabel: "Configure legacy Granola API ingestion in Wiki sources",
  },
  "google-calendar": {
    name: "google-calendar",
    kind: "mcp",
    label: "Google Calendar",
    description: "List calendars, read your schedule, and create calendar events.",
    category: "productivity",
    source:
      "https://github.com/useopencompany/plugins/tree/de04f0c11eeb4e4eb4ed1140818205e14b08401f/google-calendar",
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
    source:
      "https://github.com/useopencompany/plugins/tree/bae88070e498725de008e358a74bd18bc46ed27c/google-drive",
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
    source:
      "https://github.com/useopencompany/plugins/tree/6b4e00b71f7d1b388fe5aa225aa86c8d35ba2578/hubspot",
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
    source:
      "https://github.com/useopencompany/plugins/tree/f283f509c195464f90f5f78f7e30a9a472b6393b/infisical",
    connectionProvider: "infisical",
    connectHref: "/settings/plugins/infisical",
    accountDescription:
      "The workspace CLI connection restored into coding sandboxes. Its credentials are never sent to the documentation MCP.",
  },
  jamie: {
    name: "jamie",
    kind: "mcp",
    label: "Jamie",
    description:
      "Search meeting notes and transcripts, review action items, and organize meetings with approval.",
    category: "productivity",
    source:
      "https://github.com/useopencompany/plugins/tree/ad062203fcbb628ad27572d564cd536025f2d6ed/jamie",
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
    source:
      "https://github.com/useopencompany/plugins/tree/56855e7d53ee3544520ec1fdef84d9e2f5ae6896/latitude",
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
    source:
      "https://github.com/useopencompany/plugins/tree/775df7a9a37f5585b9b87a26533ba6ed1035f1dc/linear",
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
    source:
      "https://github.com/useopencompany/plugins/tree/bbec4c01a46b6d7bf1ffffda87af898060dd7916/neon",
    connectionProvider: "neon",
    connectHref: "/api/integrations/neon/start?returnTo=/settings/plugins/neon",
    accountDescription: "The account opencompany uses when you run Neon tools.",
  },
  posthog: {
    name: "posthog",
    kind: "mcp",
    label: "PostHog",
    description:
      "Explore dashboards, insights, schemas, and product analytics, with permission-gated insight creation.",
    category: "business",
    source:
      "https://github.com/useopencompany/plugins/tree/4ba32cd5a7618d9be3714ec0efd3c8784209046c/posthog",
    connectionProvider: "posthog",
    connectHref: "/api/integrations/posthog/start?returnTo=/settings/plugins/posthog",
    accountDescription: "The PostHog account opencompany uses when you run analytics tools.",
  },
  render: {
    name: "render",
    kind: "mcp",
    label: "Render",
    description:
      "Inspect Render infrastructure, troubleshoot services, and deploy permission-gated applications and datastores.",
    category: "engineering",
    source:
      "https://github.com/useopencompany/plugins/tree/569241125c96a07b9072d42aee404822a6950b26/render",
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
    source:
      "https://github.com/useopencompany/plugins/tree/14e7f6d3e978103c5427c725229ae93bc3e47f8c/vercel",
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
    source:
      "https://github.com/useopencompany/plugins/tree/053e9e9207f320651f1cb9b4e8feb84ab2af6bba/signoz",
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
    source:
      "https://github.com/useopencompany/plugins/tree/1b912fe6c4f4497147887b2383f0181f763aa19b/slack",
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
    source:
      "https://github.com/useopencompany/plugins/tree/68c22e8a1ffe5eb8a83fb91c68f76f3f45705d3a/stripe",
    connectionProvider: "stripe",
    connectHref: "/settings/plugins/stripe#stripe-restricted-key",
    accountDescription:
      "A workspace-owned restricted API key controls which Stripe resources plugin tools can access.",
  },
  x: {
    name: "x",
    kind: "mcp",
    label: "X",
    description: "Research public conversations and manage your X account with approval.",
    category: "communication",
    source:
      "https://github.com/useopencompany/plugins/tree/21060c09d1bbe70df85519cc3ad74cd5d097fbb6/x",
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
    source:
      "https://github.com/useopencompany/plugins/tree/2e092c3bc518622f1dc4ac1a6777d87ae3695ec6/yc-advise",
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
