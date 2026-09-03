export type OfficialMcpPluginName =
  | "betterstack"
  | "github"
  | "google-calendar"
  | "google-drive"
  | "linear"
  | "neon"
  | "render"
  | "signoz"
  | "slack";
export type OfficialSkillPluginName = "yc-advise";
export type OfficialPluginName = OfficialMcpPluginName | OfficialSkillPluginName;

type OfficialPluginMetadataBase = {
  name: OfficialPluginName;
  label: string;
  description: string;
  source: string;
};

export type OfficialMcpPluginMetadata = OfficialPluginMetadataBase & {
  name: OfficialMcpPluginName;
  kind: "mcp";
  connectionProvider:
    | "betterstack"
    | "github_user"
    | "google_calendar"
    | "google_drive"
    | "linear"
    | "neon"
    | "render"
    | "signoz"
    | "slack";
  connectHref: string;
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
  betterstack: {
    name: "betterstack",
    kind: "mcp",
    label: "Better Stack",
    description:
      "Investigate observability data and manage monitoring, incidents, dashboards, and team access.",
    source:
      "https://github.com/useopencompany/plugins/tree/cd2ab3510ce35031bb564fbd2d4d55b825a4a83b/betterstack",
    connectionProvider: "betterstack",
    connectHref: "/api/integrations/betterstack/start?returnTo=/settings/plugins/betterstack",
    accountDescription: "The account opencompany uses when you run Better Stack tools.",
  },
  github: {
    name: "github",
    kind: "mcp",
    label: "GitHub as you",
    description: "Work with repositories, issues, pull requests, and Actions as yourself.",
    source:
      "https://github.com/useopencompany/plugins/tree/232e380e8850c440c28e4588ef79143d41c000db/github",
    connectionProvider: "github_user",
    connectHref: "/api/integrations/github-user/start?returnTo=/settings/plugins/github",
    accountLabel: "GitHub",
    accountDescription: "The personal GitHub account opencompany uses when it works as you.",
  },
  "google-calendar": {
    name: "google-calendar",
    kind: "mcp",
    label: "Google Calendar",
    description: "List calendars, read your schedule, and create calendar events.",
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
    description: "Browse, read, create, and copy files through opencompany's Google Drive MCP.",
    source:
      "https://github.com/useopencompany/plugins/tree/dc0c91221bcfa9b6088a19277f875c438b37e96e/google-drive",
    connectionProvider: "google_drive",
    connectHref: "/api/integrations/google-drive/start?returnTo=/settings/plugins/google-drive",
    accountDescription:
      "The most recently connected Google Drive account powers plugin tools. Other accounts remain available for Wiki ingestion.",
    ingestionHref: "/wiki/sources",
    ingestionLabel: "Configure Google Drive ingestion in Wiki sources",
  },
  linear: {
    name: "linear",
    kind: "mcp",
    label: "Linear",
    description: "Work with Linear issues, projects, comments, and team workflows.",
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
    source:
      "https://github.com/useopencompany/plugins/tree/bbec4c01a46b6d7bf1ffffda87af898060dd7916/neon",
    connectionProvider: "neon",
    connectHref: "/api/integrations/neon/start?returnTo=/settings/plugins/neon",
    accountDescription: "The account opencompany uses when you run Neon tools.",
  },
  render: {
    name: "render",
    kind: "mcp",
    label: "Render",
    description:
      "Inspect Render infrastructure, troubleshoot services, and deploy permission-gated applications and datastores.",
    source:
      "https://github.com/useopencompany/plugins/tree/569241125c96a07b9072d42aee404822a6950b26/render",
    connectionProvider: "render",
    connectHref: "/settings/plugins/render#render-api-key",
    accountDescription: "The Render account opencompany uses when you run Render tools.",
  },
  signoz: {
    name: "signoz",
    kind: "mcp",
    label: "SigNoz",
    description: "Investigate logs, metrics, traces, alerts, and dashboards in SigNoz US Cloud.",
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
    source:
      "https://github.com/useopencompany/plugins/tree/1b912fe6c4f4497147887b2383f0181f763aa19b/slack",
    connectionProvider: "slack",
    connectHref: "/api/integrations/slack/start?returnTo=/settings/plugins/slack",
    accountDescription: "The most recently connected Slack account powers Slack tools.",
  },
} as const satisfies Record<OfficialMcpPluginName, OfficialMcpPluginMetadata>;

export const OFFICIAL_SKILL_PLUGIN_METADATA = {
  "yc-advise": {
    name: "yc-advise",
    kind: "skills",
    label: "YC Advise",
    description:
      "Independent YC-style startup advice and structured founder office hours, based on public principles and not affiliated with Y Combinator.",
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
