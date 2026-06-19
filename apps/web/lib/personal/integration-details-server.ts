import type { GoogleIntegrationState } from "@/lib/integrations/google-data";
import type { McpProviderKey, WorkspaceMcpSettings } from "@/lib/mcp/data";
import type {
  PersonalIntegrationAccountDetail,
  PersonalIntegrationDetail,
  PersonalIntegrationDetails,
  PersonalIntegrationResourceDetail,
} from "@/lib/personal/integration-details";

// Maps the workspace integration state the /personal layout already loads into the serializable
// per-integration details the Integrations tab renders. Pure projection — no extra queries.

type GitHubIntegrationState = {
  connections: Array<{
    id: string;
    connectionLabel: string;
    accountLogin: string | null;
    accountType: string | null;
    status: "connected" | "needs_reauth" | "sync_failed" | "disconnected";
    statusReason: string | null;
    updatedAt: string;
    repositories: Array<{
      fullName: string;
      defaultBranch: string;
      status: "available" | "permission_lost" | "archived" | "sync_failed";
      statusReason: string | null;
    }>;
  }>;
};

const GITHUB_REPOSITORY_WARNINGS: Record<string, string | null> = {
  available: null,
  permission_lost: "Access lost",
  archived: "Archived",
  sync_failed: "Sync failed",
};

export function buildPersonalIntegrationDetails(input: {
  github: GitHubIntegrationState;
  google: GoogleIntegrationState;
  mcp: WorkspaceMcpSettings;
}): PersonalIntegrationDetails {
  return {
    github: buildGitHubDetail(input.github),
    gmail: buildGoogleDetail(input.google.gmail.connections, null),
    google_calendar: buildGoogleDetail(input.google.google_calendar.connections, "Calendars"),
    linear: buildMcpDetail(input.mcp.linear),
    slack: buildMcpDetail(input.mcp.slack, { accounts: true }),
    posthog: buildMcpDetail(input.mcp.posthog),
    betterstack: buildMcpDetail(input.mcp.betterstack),
    braintrust: buildMcpDetail(input.mcp.braintrust),
    notion: buildMcpDetail(input.mcp.notion),
  };
}

function buildGitHubDetail(github: GitHubIntegrationState): PersonalIntegrationDetail {
  const connections = github.connections.filter(
    (connection) => connection.status !== "disconnected",
  );
  const accounts: PersonalIntegrationAccountDetail[] = connections.map((connection) => ({
    id: connection.id,
    label: connection.accountLogin ? `@${connection.accountLogin}` : connection.connectionLabel,
    detail: connection.accountType,
    status: connection.status,
    statusReason: connection.statusReason,
    updatedAt: connection.updatedAt,
    resources: connection.repositories.map(
      (repository): PersonalIntegrationResourceDetail => ({
        id: repository.fullName,
        name: repository.fullName,
        detail: null,
        warning: GITHUB_REPOSITORY_WARNINGS[repository.status] ?? null,
      }),
    ),
  }));

  const repositoryCount = accounts.reduce((sum, account) => sum + account.resources.length, 0);
  const summary =
    accounts.length === 0
      ? null
      : accounts.length === 1
        ? `Connected as ${accounts[0]!.label} · ${pluralize(repositoryCount, "repository", "repositories")}`
        : `${accounts.length} accounts · ${pluralize(repositoryCount, "repository", "repositories")}`;

  return {
    summary,
    accounts,
    resourcesLabel: "Repositories",
    statusReason: null,
  };
}

function buildGoogleDetail(
  connections: GoogleIntegrationState["gmail"]["connections"],
  resourcesLabel: string | null,
): PersonalIntegrationDetail {
  const active = connections.filter((connection) => connection.status !== "disconnected");
  const accounts: PersonalIntegrationAccountDetail[] = active.map((connection) => ({
    id: connection.id,
    label: connection.accountEmail ?? connection.connectionLabel,
    detail: connection.accountName,
    status: connection.status,
    statusReason: connection.statusReason,
    updatedAt: connection.updatedAt,
    resources: connection.calendars.map(
      (calendar): PersonalIntegrationResourceDetail => ({
        id: calendar.externalId,
        name: calendar.name,
        detail: calendar.primary ? "Primary calendar" : null,
        warning: calendar.status === "available" ? null : "Access lost",
      }),
    ),
  }));

  const calendarCount = accounts.reduce((sum, account) => sum + account.resources.length, 0);
  const summary =
    accounts.length === 0
      ? null
      : accounts.length > 1
        ? resourcesLabel
          ? `${accounts.length} accounts · ${pluralize(calendarCount, "calendar", "calendars")}`
          : `${accounts.length} accounts · read-only`
        : resourcesLabel
          ? `${accounts[0]!.label} · ${pluralize(calendarCount, "calendar", "calendars")}`
          : `${accounts[0]!.label} · read-only`;

  return {
    summary,
    accounts,
    resourcesLabel,
    statusReason: null,
  };
}

function buildMcpDetail(
  settings: WorkspaceMcpSettings[McpProviderKey],
  options: { accounts?: boolean } = {},
): PersonalIntegrationDetail {
  const accounts: PersonalIntegrationAccountDetail[] = options.accounts
    ? settings.accounts.map((account) => ({
        id: account.accountKey,
        label: account.label,
        detail: account.email,
        status: settings.configured ? "connected" : "sync_failed",
        statusReason: settings.configured ? null : settings.statusReason,
        updatedAt: account.updatedAt ?? settings.updatedAt,
        resources: [],
      }))
    : [];
  const summary =
    accounts.length === 0
      ? null
      : accounts.length === 1
        ? accounts[0]!.label
        : `${accounts.length} accounts`;

  return {
    summary,
    accounts,
    resourcesLabel: null,
    statusReason:
      settings.status && settings.status !== "configured" ? settings.statusReason : null,
  };
}

function pluralize(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}
