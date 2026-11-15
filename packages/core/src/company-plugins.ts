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

export const COMPANY_SENTRY_PROVIDER = "sentry" as const;
export const COMPANY_SENTRY_INTEGRATION_PROVIDER = "sentry" as const;
const SENTRY_PROJECT_FILTER = {
  id: "project",
  label: "Project",
  required: true,
  kind: "integration_resource",
  resourceType: "project",
} as const;
const SENTRY_CONDITIONS = [
  SENTRY_PROJECT_FILTER,
  {
    id: "priority",
    label: "Priority",
    required: false,
    kind: "choice",
    options: [
      { id: "high", name: "High" },
      { id: "medium", name: "Medium" },
      { id: "low", name: "Low" },
    ],
  },
  { id: "environment", label: "Environment", required: false, kind: "text" },
  { id: "tags", label: "Exact tags", required: false, kind: "tag_pairs" },
] satisfies PluginEventDefinition["filters"];
export const COMPANY_SENTRY_EVENTS: readonly PluginEventDefinition[] = [
  {
    id: "issue.created",
    label: "Error issue created",
    description:
      "Matches the first occurrence. An issue created in staging does not later qualify as a new production issue. Priority is Sentry's triage priority, not error severity.",
    delivery: "webhook",
    filters: SENTRY_CONDITIONS,
  },
  {
    id: "issue.regressed",
    label: "Issue regressed",
    description:
      "A resolved issue regresses. Conditions use a representative occurrence at or before notification time. Manual reopening does not trigger a run.",
    delivery: "webhook",
    filters: SENTRY_CONDITIONS,
  },
  {
    id: "issue_alert.triggered",
    label: "Issue alert triggered",
    description:
      "Run the workflow selected in a Sentry alert action. Sentry controls thresholds and conditions.",
    delivery: "webhook",
    filters: [SENTRY_PROJECT_FILTER],
  },
];

const COMPANY_PLUGINS: Readonly<
  Record<string, { integrationProvider: string; events: readonly PluginEventDefinition[] }>
> = {
  [COMPANY_SENTRY_PROVIDER]: {
    integrationProvider: COMPANY_SENTRY_INTEGRATION_PROVIDER,
    events: COMPANY_SENTRY_EVENTS,
  },
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
