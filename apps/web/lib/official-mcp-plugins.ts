export type OfficialMcpPluginName = "linear" | "neon" | "betterstack";

export type OfficialMcpPluginMetadata = {
  name: OfficialMcpPluginName;
  label: string;
  description: string;
  source: string;
  connectHref: string;
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
    connectHref: "/api/integrations/betterstack/start?returnTo=/settings/plugins/betterstack",
    accountDescription: "The account opencompany uses when you run Better Stack tools.",
  },
  linear: {
    name: "linear",
    label: "Linear",
    description: "Work with Linear issues, projects, comments, and team workflows.",
    source:
      "https://github.com/useopencompany/plugins/tree/775df7a9a37f5585b9b87a26533ba6ed1035f1dc/linear",
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
    connectHref: "/api/integrations/neon/start?returnTo=/settings/plugins/neon",
    accountDescription: "The account opencompany uses when you run Neon tools.",
  },
} as const satisfies Record<OfficialMcpPluginName, OfficialMcpPluginMetadata>;

export function isOfficialMcpPluginName(value: string): value is OfficialMcpPluginName {
  return value === value.toLocaleLowerCase() && Object.hasOwn(OFFICIAL_MCP_PLUGIN_METADATA, value);
}
