export type OfficialMcpPluginName =
  | "betterstack"
  | "github"
  | "google-calendar"
  | "linear"
  | "neon"
  | "slack";

export type OfficialMcpPluginMetadata = {
  name: OfficialMcpPluginName;
  label: string;
  description: string;
  source: string;
  connectionProvider:
    | "betterstack"
    | "github_user"
    | "google_calendar"
    | "linear"
    | "neon"
    | "slack";
  connectHref: string;
  accountLabel?: string;
  accountDescription: string;
  ingestionHref?: string;
  ingestionLabel?: string;
};

// The public repository is the reviewed trust boundary. Keep every source pinned to a full commit.
export const OFFICIAL_MCP_PLUGIN_METADATA = {
  betterstack: {
    name: "betterstack",
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
    label: "Google Calendar",
    description: "List calendars, read your schedule, and create calendar events.",
    source:
      "https://github.com/useopencompany/plugins/tree/de04f0c11eeb4e4eb4ed1140818205e14b08401f/google-calendar",
    connectionProvider: "google_calendar",
    connectHref:
      "/api/integrations/google-calendar/start?returnTo=/settings/plugins/google-calendar",
    accountDescription: "The Google account opencompany uses when you run Calendar tools.",
  },
  linear: {
    name: "linear",
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
    label: "Neon",
    description:
      "Inspect Neon projects and database structure, and run permission-gated read-only SQL.",
    source:
      "https://github.com/useopencompany/plugins/tree/bbec4c01a46b6d7bf1ffffda87af898060dd7916/neon",
    connectionProvider: "neon",
    connectHref: "/api/integrations/neon/start?returnTo=/settings/plugins/neon",
    accountDescription: "The account opencompany uses when you run Neon tools.",
  },
  slack: {
    name: "slack",
    label: "Slack",
    description: "Search Slack and, with approval, read private content or make changes.",
    source:
      "https://github.com/useopencompany/plugins/tree/1b912fe6c4f4497147887b2383f0181f763aa19b/slack",
    connectionProvider: "slack",
    connectHref: "/api/integrations/slack/start?returnTo=/settings/plugins/slack",
    accountDescription: "The most recently connected Slack account powers Slack tools.",
  },
} as const satisfies Record<OfficialMcpPluginName, OfficialMcpPluginMetadata>;

export function isOfficialMcpPluginName(value: string): value is OfficialMcpPluginName {
  return value === value.toLocaleLowerCase() && Object.hasOwn(OFFICIAL_MCP_PLUGIN_METADATA, value);
}
