import type { PluginEventDefinition } from "./plugin-import";

// Company plugins belong to the workspace rather than to one member. An admin connects them once and
// every member's company automations can use them. Unlike personal plugins they are not installed
// from a package: the platform owns their connection, ingress, and event vocabulary, so their event
// declarations live here instead of in a reviewed manifest.

// The provider an event trigger names. Trigger and event-run providers share the plugin-name
// grammar, which has no underscores.
export const COMPANY_GITHUB_PROVIDER = "github-app" as const;
// The workspace-owned connection row: a GitHub App installation linked to a workspace.
export const COMPANY_GITHUB_INTEGRATION_PROVIDER = "github_app" as const;

const REPOSITORY_FILTER = {
  id: "repository",
  label: "Repository",
  required: true,
  kind: "integration_resource",
  resourceType: "repository",
} as const satisfies PluginEventDefinition["filters"][number];

export const COMPANY_GITHUB_EVENTS = [
  {
    id: "issue.opened",
    label: "Issue opened",
    description: "Someone opens an issue in the repository.",
    delivery: "webhook",
    filters: [REPOSITORY_FILTER],
  },
  {
    id: "pull_request.opened",
    label: "Pull request opened",
    description: "Someone opens a pull request, including drafts, in the repository.",
    delivery: "webhook",
    filters: [REPOSITORY_FILTER],
  },
] as const satisfies readonly PluginEventDefinition[];

export type CompanyGitHubEventId = (typeof COMPANY_GITHUB_EVENTS)[number]["id"];

const COMPANY_PLUGINS: Readonly<
  Record<string, { integrationProvider: string; events: readonly PluginEventDefinition[] }>
> = {
  [COMPANY_GITHUB_PROVIDER]: {
    integrationProvider: COMPANY_GITHUB_INTEGRATION_PROVIDER,
    events: COMPANY_GITHUB_EVENTS,
  },
};

export function isCompanyPluginProvider(provider: string) {
  return Object.hasOwn(COMPANY_PLUGINS, provider);
}

export function companyPluginIntegrationProvider(provider: string) {
  return COMPANY_PLUGINS[provider]?.integrationProvider ?? null;
}

export function companyPluginEvent(provider: string, eventId: string) {
  return COMPANY_PLUGINS[provider]?.events.find((event) => event.id === eventId) ?? null;
}

// `provider:integrationProvider:event` for every declared company plugin event, for checks that
// run in SQL against an event run and the connection its trigger names.
export function companyPluginEventKeys() {
  return Object.entries(COMPANY_PLUGINS).flatMap(([provider, plugin]) =>
    plugin.events.map((event) => `${provider}:${plugin.integrationProvider}:${event.id}`),
  );
}
