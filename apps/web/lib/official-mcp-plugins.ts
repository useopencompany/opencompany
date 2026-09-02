export type OfficialMcpPluginName = "linear" | "neon" | "infisical";

export type OfficialMcpPluginMetadata = {
  name: OfficialMcpPluginName;
  label: string;
  description: string;
  source: string;
  connectHref: string;
  accountDescription: string;
  connectionKind: "account" | "workspace-infisical";
  permissionsEditable: boolean;
  toolsDescription: string;
  ingestionHref?: string;
  ingestionLabel?: string;
};

// The public repository is the reviewed trust boundary. Keep every source pinned to a full commit.
export const OFFICIAL_MCP_PLUGIN_METADATA = {
  linear: {
    name: "linear",
    label: "Linear",
    description: "Work with Linear issues, projects, comments, and team workflows.",
    source:
      "https://github.com/useopencompany/plugins/tree/775df7a9a37f5585b9b87a26533ba6ed1035f1dc/linear",
    connectHref: "/api/integrations/linear/start?returnTo=/settings/plugins/linear",
    accountDescription: "The account opencompany uses when you run Linear tools.",
    connectionKind: "account",
    permissionsEditable: true,
    toolsDescription:
      "Choose whether Linear capabilities run automatically, ask first, or stay unavailable.",
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
    connectionKind: "account",
    permissionsEditable: true,
    toolsDescription:
      "Choose whether Neon capabilities run automatically, ask first, or stay unavailable.",
  },
  infisical: {
    name: "infisical",
    label: "Infisical",
    description:
      "Search Infisical docs and safely use the connected CLI for sandbox environment secrets.",
    source:
      "https://github.com/useopencompany/plugins/tree/a877d1d763f8a44b152f362fe5a7001840c25560/infisical",
    connectHref: "/settings/integrations",
    accountDescription:
      "The workspace CLI connection restored into coding sandboxes. Its credentials are never sent to the documentation MCP.",
    connectionKind: "workspace-infisical",
    permissionsEditable: false,
    toolsDescription:
      "Documentation reads are fixed On and documentation feedback is fixed Off. Sandbox secret access uses the CLI workflow in the plugin skill.",
  },
} as const satisfies Record<OfficialMcpPluginName, OfficialMcpPluginMetadata>;

export function isOfficialMcpPluginName(value: string): value is OfficialMcpPluginName {
  return value === value.toLocaleLowerCase() && Object.hasOwn(OFFICIAL_MCP_PLUGIN_METADATA, value);
}
