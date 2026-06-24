"use client";

import {
  CalendarDays,
  CheckCircle2,
  Database,
  ExternalLink,
  Files,
  GitBranch,
  type LucideIcon,
  Mail,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { ToolPolicyEditor } from "@/components/ToolPolicyEditor";
import {
  disconnectGitHubIntegrationAction,
  refreshGitHubRepositories,
} from "@/lib/integrations/actions";
import {
  disconnectGoogleIntegrationAction,
  setGoogleCalendarSelection,
} from "@/lib/integrations/google-actions";
import type { GoogleConnectionState, GoogleProviderState } from "@/lib/integrations/google-data";
import {
  disconnectNeonIntegrationAction,
  refreshNeonConnectionAction,
  saveNeonApiKeyAction,
  setNeonDatabaseSelectionAction,
} from "@/lib/integrations/neon";
import type { WorkspaceToolPolicyOverrides } from "@/lib/tool-policies/data";

type IntegrationStatus =
  | "not_connected"
  | "connected"
  | "needs_repository_access"
  | "needs_reauth"
  | "sync_failed"
  | "error";
type ResourceStatus = "available" | "permission_lost" | "archived" | "sync_failed";
type IntegrationProviderId = "github" | "neon" | "gmail" | "google_calendar" | "google_drive";
type IntegrationCategory = "Code" | "Data" | "Communication" | "Productivity";

type WorkspaceIntegrationState = {
  github: {
    status: IntegrationStatus;
    connections: Array<{
      id: string;
      installationId: string;
      connectionLabel: string;
      accountLogin: string | null;
      accountType: string | null;
      status: "connected" | "needs_reauth" | "sync_failed" | "disconnected";
      statusReason: string | null;
      updatedAt: string;
      repositories: Array<{
        fullName: string;
        defaultBranch: string;
        status: ResourceStatus;
        statusReason: string | null;
        lastSyncedAt: string | null;
        selectedAt: string | null;
      }>;
    }>;
  };
  gmail: GoogleProviderState;
  google_calendar: GoogleProviderState;
  google_drive: GoogleProviderState;
  neon: {
    status: IntegrationStatus;
    connections: Array<{
      id: string;
      projectId: string;
      connectionLabel: string;
      accountName: string | null;
      status: "connected" | "needs_reauth" | "sync_failed" | "disconnected";
      statusReason: string | null;
      updatedAt: string;
      databases: Array<{
        id: string;
        externalId: string;
        name: string;
        displayName: string;
        status: ResourceStatus;
        statusReason: string | null;
        selectedAt: string | null;
        metadata: {
          projectId: string;
          projectName: string | null;
          branchId: string;
          branchName: string | null;
          databaseName: string;
          roleName: string;
        };
      }>;
    }>;
  };
};
type GitHubConnection = WorkspaceIntegrationState["github"]["connections"][number];

/**
 * Deep-link to a connection's GitHub installation settings, where the user grants or revokes which
 * repositories the OpenCompany GitHub App can access. Organisation and user installations live at
 * different URLs, so branch on the account type.
 */
function githubConfigureUrl(connection: GitHubConnection): string {
  if (connection.accountType === "Organization" && connection.accountLogin) {
    return `https://github.com/organizations/${connection.accountLogin}/settings/installations/${connection.installationId}`;
  }
  return `https://github.com/settings/installations/${connection.installationId}`;
}
type NeonConnection = WorkspaceIntegrationState["neon"]["connections"][number];
type DisconnectFeedback = {
  connectionId: string;
  type: "success" | "error";
  message: string;
};

type IntegrationDefinition = {
  id: IntegrationProviderId;
  name: string;
  category: IntegrationCategory;
  description: string;
  icon: LucideIcon;
};

type IntegrationCardState = {
  status: IntegrationStatus;
  label: string;
  description: string;
};

type Filter = "all" | "connected" | "available" | "needs_attention";

const INTEGRATIONS: IntegrationDefinition[] = [
  {
    id: "github",
    name: "GitHub",
    category: "Code",
    description: "Connect repositories agents can clone, edit, and open pull requests against.",
    icon: GitBranch,
  },
  {
    id: "neon",
    name: "Neon",
    category: "Data",
    description:
      "Let agents inspect, query, and administer selected Neon Postgres databases with approval gates.",
    icon: Database,
  },
  {
    id: "gmail",
    name: "Gmail",
    category: "Communication",
    description: "Let agents read mail from one or more connected Google accounts (read-only).",
    icon: Mail,
  },
  {
    id: "google_calendar",
    name: "Google Calendar",
    category: "Productivity",
    description: "Let agents read and manage events on selected calendars (read & write).",
    icon: CalendarDays,
  },
  {
    id: "google_drive",
    name: "Google Drive",
    category: "Productivity",
    description: "Let agents create and update Drive documents OpenCompany can access.",
    icon: Files,
  },
];

export default function IntegrationsView({
  integrations,
  toolPolicies,
}: {
  integrations: WorkspaceIntegrationState;
  toolPolicies: WorkspaceToolPolicyOverrides;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const visibleIntegrations = useMemo(
    () =>
      INTEGRATIONS.filter((integration) => {
        const normalized = query.trim().toLowerCase();
        const state = integrationState(integration.id, integrations);
        const matchesQuery =
          normalized.length === 0 ||
          integration.name.toLowerCase().includes(normalized) ||
          integration.description.toLowerCase().includes(normalized);
        const matchesFilter =
          filter === "all" ||
          (filter === "connected" && state.status === "connected") ||
          (filter === "available" && state.status === "not_connected") ||
          (filter === "needs_attention" &&
            (state.status === "needs_repository_access" ||
              state.status === "needs_reauth" ||
              state.status === "sync_failed" ||
              state.status === "error"));

        return matchesQuery && matchesFilter;
      }),
    [filter, integrations, query],
  );

  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-8 pb-24 pt-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Integrations</h1>
            <p className="mt-1 max-w-[560px] text-[13px] leading-5 tracking-[-0.005em] text-ink-muted">
              Connect external resources agents can access. Platform-supported tools such as AMP are
              enabled from agent configuration instead of user-supplied credentials.
            </p>
          </div>
        </div>

        <div className="mt-7 flex flex-wrap items-center gap-2">
          <div className="flex h-8 min-w-[260px] flex-1 items-center gap-2 rounded-md border border-border bg-surface/70 px-2.5">
            <Search size={13} strokeWidth={1.9} className="text-ink-subtle" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search integrations"
              className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-subtle"
            />
          </div>
          {(["all", "connected", "available", "needs_attention"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setFilter(item)}
              className={`h-8 rounded-md border px-2.5 text-[12.5px] font-medium ${
                filter === item
                  ? "border-ink/20 bg-ink text-canvas"
                  : "border-border bg-surface/65 text-ink-muted hover:bg-surface"
              }`}
            >
              {filterLabel(item)}
            </button>
          ))}
        </div>

        <section className="mt-6">
          <SectionHeader
            title="Workspace integrations"
            description="External accounts and resources agents can read, write, or act on."
          />
          <div className="mt-3 grid gap-3">
            {visibleIntegrations.map((integration) => (
              <IntegrationCard
                key={integration.id}
                integration={integration}
                state={integrationState(integration.id, integrations)}
                integrations={integrations}
                policyOverrides={toolPolicies[integration.id]}
              />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-[12.5px] font-semibold text-ink">{title}</h2>
      <p className="mt-1 text-[12px] leading-5 text-ink-muted">{description}</p>
    </div>
  );
}

function IntegrationCard({
  integration,
  state,
  integrations,
  policyOverrides,
}: {
  integration: IntegrationDefinition;
  state: IntegrationCardState;
  integrations: WorkspaceIntegrationState;
  policyOverrides: WorkspaceToolPolicyOverrides[string] | undefined;
}) {
  const Icon = integration.icon;
  const StatusIcon = state.status === "connected" ? CheckCircle2 : ShieldAlert;

  return (
    <section className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
            <Icon size={17} strokeWidth={1.85} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[13.5px] font-semibold tracking-[-0.005em] text-ink">
                {integration.name}
              </h2>
              <span className="rounded-full border border-border bg-canvas px-2 py-0.5 text-[10.5px] font-medium text-ink-subtle">
                {integration.category}
              </span>
            </div>
            <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">{integration.description}</p>
          </div>
        </div>
        <span
          role="status"
          aria-label={`Integration status: ${state.label}`}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${statusClass(
            state.status,
          )}`}
        >
          <StatusIcon size={11} strokeWidth={2} />
          {state.label}
        </span>
      </div>

      <div className="mt-4 border-t border-border-subtle pt-4">
        <IntegrationControls provider={integration.id} integrations={integrations} />
      </div>
      {state.status === "connected" ? (
        <ToolPolicyEditor providerKey={integration.id} overrides={policyOverrides} />
      ) : null}
    </section>
  );
}

function IntegrationControls({
  provider,
  integrations,
}: {
  provider: IntegrationProviderId;
  integrations: WorkspaceIntegrationState;
}) {
  switch (provider) {
    case "github":
      return <GitHubControls integration={integrations.github} />;
    case "neon":
      return <NeonControls integration={integrations.neon} />;
    case "gmail":
      return <GoogleControls provider="gmail" integration={integrations.gmail} />;
    case "google_calendar":
      return (
        <GoogleControls provider="google_calendar" integration={integrations.google_calendar} />
      );
    case "google_drive":
      return <GoogleControls provider="google_drive" integration={integrations.google_drive} />;
  }
  return assertNever(provider);
}

function GitHubControls({ integration }: { integration: WorkspaceIntegrationState["github"] }) {
  const router = useRouter();
  const [isDisconnecting, startDisconnectTransition] = useTransition();
  const [disconnectingConnectionId, setDisconnectingConnectionId] = useState<string | null>(null);
  const [disconnectCandidate, setDisconnectCandidate] = useState<GitHubConnection | null>(null);
  const [disconnectFeedback, setDisconnectFeedback] = useState<DisconnectFeedback | null>(null);
  const connected = integration.connections.length > 0;
  const configured = integration.status !== "error";
  const repositoryCount = integration.connections.reduce(
    (count, connection) => count + connection.repositories.length,
    0,
  );
  const availableRepositoryCount = integration.connections.reduce(
    (count, connection) =>
      count +
      connection.repositories.filter((repository) => repository.status === "available").length,
    0,
  );

  function requestDisconnectGitHub(connection: GitHubConnection) {
    if (isDisconnecting) return;
    setDisconnectFeedback(null);
    setDisconnectCandidate(connection);
  }

  function confirmDisconnectGitHub() {
    const connection = disconnectCandidate;
    if (!connection) return;

    setDisconnectCandidate(null);
    setDisconnectFeedback(null);
    setDisconnectingConnectionId(connection.id);
    startDisconnectTransition(async () => {
      try {
        const result = await disconnectGitHubIntegrationAction(connection.id);
        setDisconnectFeedback({
          connectionId: connection.id,
          type: result.ok ? "success" : "error",
          message: result.message,
        });
        if (result.ok) {
          router.refresh();
        }
      } finally {
        setDisconnectingConnectionId(null);
      }
    });
  }

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-3">
        <InfoField label="Connections" value={String(integration.connections.length)} />
        <InfoField
          label="Repositories"
          value={`${availableRepositoryCount}/${repositoryCount} available`}
        />
        <InfoField
          label="Last refresh"
          value={latestRefreshLabel(
            integration.connections.map((connection) => connection.updatedAt),
          )}
        />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {configured ? (
          <a
            href={`/api/integrations/github/start?intent=settings&returnTo=${encodeURIComponent(
              "/company/settings/integrations",
            )}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] hover:bg-ink/85"
          >
            <ExternalLink size={13} strokeWidth={1.9} />
            {connected ? "Connect another GitHub account" : "Connect GitHub"}
          </a>
        ) : (
          <button
            type="button"
            disabled
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-surface-active px-3 text-[12.5px] font-medium text-ink-subtle"
          >
            <ShieldAlert size={13} strokeWidth={1.9} />
            Not configured
          </button>
        )}
      </div>
      {integration.connections.length > 0 ? (
        <div className="mt-4 overflow-hidden rounded-md border border-border bg-surface/55">
          {integration.connections.map((connection) => (
            <div key={connection.id} className="border-t border-border-subtle p-3 first:border-t-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[12.5px] font-semibold text-ink">
                    {connection.connectionLabel}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-ink-subtle">
                    {connection.accountType ?? "Account"} - {formatDateTime(connection.updatedAt)}
                  </div>
                  {connection.status !== "connected" ? (
                    <p className="mt-1 text-[11.5px] leading-4 text-warning">
                      {connection.statusReason ?? integrationStatusDescription(connection.status)}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {connection.status !== "connected" ? (
                    <span
                      role="status"
                      aria-label={`GitHub connection status: ${integrationStatusLabel(
                        connection.status,
                      )}`}
                      className={`inline-flex h-8 items-center rounded-md border px-2 text-[11.5px] font-medium ${statusClass(
                        connection.status,
                      )}`}
                    >
                      {integrationStatusLabel(connection.status)}
                    </span>
                  ) : null}
                  <a
                    href={githubConfigureUrl(connection)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink hover:bg-canvas"
                  >
                    <ExternalLink size={13} strokeWidth={1.9} />
                    Configure on GitHub
                  </a>
                  <form action={refreshGitHubRepositories.bind(null, connection.id)}>
                    <RefreshRepositoriesButton />
                  </form>
                  <button
                    type="button"
                    onClick={() => requestDisconnectGitHub(connection)}
                    disabled={isDisconnecting}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger-border bg-surface px-3 text-[12.5px] font-medium text-danger hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-65"
                  >
                    <Trash2 size={13} strokeWidth={1.9} />
                    {disconnectingConnectionId === connection.id ? "Uninstalling" : "Uninstall"}
                  </button>
                </div>
              </div>
              {disconnectFeedback?.connectionId === connection.id ? (
                <p
                  className={`mt-2 text-[12px] leading-5 ${
                    disconnectFeedback.type === "success" ? "text-success" : "text-danger"
                  }`}
                >
                  {disconnectFeedback.message}
                </p>
              ) : null}
              {connection.repositories.length > 0 ? (
                <div className="mt-3 max-h-[150px] overflow-y-auto rounded-md border border-border-subtle bg-surface/60">
                  {connection.repositories.map((repository) => (
                    <div
                      key={`${connection.id}:${repository.fullName}`}
                      className="border-t border-border-subtle px-3 py-2 first:border-t-0"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <span className="truncate text-[12.5px] font-medium text-ink">
                          {repository.fullName}
                        </span>
                        <div className="flex shrink-0 items-center gap-2">
                          {repository.status !== "available" ? (
                            <span
                              role="status"
                              aria-label={`Repository status: ${resourceStatusLabel(
                                repository.status,
                              )}`}
                              className={`rounded border px-1.5 py-0.5 text-[10.5px] font-medium ${resourceStatusClass(
                                repository.status,
                              )}`}
                            >
                              {resourceStatusLabel(repository.status)}
                            </span>
                          ) : null}
                          <span className="text-[11.5px] text-ink-subtle">
                            {repository.defaultBranch}
                          </span>
                        </div>
                      </div>
                      {repository.status !== "available" ? (
                        <p className="mt-1 text-[11.5px] leading-4 text-ink-muted">
                          {repository.statusReason ??
                            "This repository is not currently visible to the GitHub installation."}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <DisconnectGitHubDialog
        connection={disconnectCandidate}
        isPending={isDisconnecting}
        onCancel={() => setDisconnectCandidate(null)}
        onConfirm={confirmDisconnectGitHub}
      />
    </div>
  );
}

function NeonControls({ integration }: { integration: WorkspaceIntegrationState["neon"] }) {
  const router = useRouter();
  const [isDisconnecting, startDisconnectTransition] = useTransition();
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<DisconnectFeedback | null>(null);
  const connected = integration.connections.length > 0;
  const databaseCount = integration.connections.reduce(
    (count, connection) => count + connection.databases.length,
    0,
  );
  const selectedDatabaseCount = integration.connections.reduce(
    (count, connection) =>
      count +
      connection.databases.filter(
        (database) => database.status === "available" && database.selectedAt !== null,
      ).length,
    0,
  );

  function disconnect(connection: NeonConnection) {
    if (isDisconnecting) return;
    setFeedback(null);
    setDisconnectingId(connection.id);
    startDisconnectTransition(async () => {
      try {
        const result = await disconnectNeonIntegrationAction(connection.id);
        setFeedback({
          connectionId: connection.id,
          type: result.ok ? "success" : "error",
          message: result.message,
        });
        if (result.ok) router.refresh();
      } finally {
        setDisconnectingId(null);
      }
    });
  }

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-3">
        <InfoField label="Projects" value={String(integration.connections.length)} />
        <InfoField label="Databases" value={`${selectedDatabaseCount}/${databaseCount} selected`} />
        <InfoField
          label="Last updated"
          value={latestRefreshLabel(
            integration.connections.map((connection) => connection.updatedAt),
          )}
        />
      </div>
      <form action={saveNeonApiKeyAction} className="mt-4 flex flex-wrap items-center gap-2">
        <input
          type="password"
          name="apiKey"
          placeholder={connected ? "Replace Neon API key" : "Neon API key"}
          autoComplete="off"
          className="h-8 min-w-[260px] flex-1 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-subtle"
        />
        <SaveNeonButton connected={connected} />
      </form>
      {connected ? (
        <div className="mt-4 overflow-hidden rounded-md border border-border bg-surface/55">
          {integration.connections.map((connection) => (
            <div key={connection.id} className="border-t border-border-subtle p-3 first:border-t-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[12.5px] font-semibold text-ink">
                    {connection.connectionLabel}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-ink-subtle">
                    Neon project - {formatDateTime(connection.updatedAt)}
                  </div>
                  {connection.status !== "connected" ? (
                    <p className="mt-1 text-[11.5px] leading-4 text-warning">
                      {connection.statusReason ?? "Reconnect Neon to restore access."}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <form action={refreshNeonConnectionAction.bind(null, connection.id)}>
                    <RefreshNeonButton />
                  </form>
                  <button
                    type="button"
                    onClick={() => disconnect(connection)}
                    disabled={isDisconnecting}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger-border bg-surface px-3 text-[12.5px] font-medium text-danger hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-65"
                  >
                    <Trash2 size={13} strokeWidth={1.9} />
                    {disconnectingId === connection.id ? "Disconnecting" : "Disconnect"}
                  </button>
                </div>
              </div>
              {feedback?.connectionId === connection.id ? (
                <p
                  className={`mt-2 text-[12px] leading-5 ${
                    feedback.type === "success" ? "text-success" : "text-danger"
                  }`}
                >
                  {feedback.message}
                </p>
              ) : null}
              <NeonDatabaseSelection connection={connection} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GoogleControls({
  provider,
  integration,
}: {
  provider: "gmail" | "google_calendar" | "google_drive";
  integration: GoogleProviderState;
}) {
  const router = useRouter();
  const [isDisconnecting, startDisconnectTransition] = useTransition();
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<DisconnectFeedback | null>(null);

  const routeSegment =
    provider === "gmail"
      ? "gmail"
      : provider === "google_calendar"
        ? "google-calendar"
        : "google-drive";
  const name =
    provider === "gmail"
      ? "Gmail"
      : provider === "google_calendar"
        ? "Google Calendar"
        : "Google Drive";
  const connected = integration.connections.length > 0;

  function disconnect(connection: GoogleConnectionState) {
    if (isDisconnecting) return;
    setFeedback(null);
    setDisconnectingId(connection.id);
    startDisconnectTransition(async () => {
      try {
        const result = await disconnectGoogleIntegrationAction({
          provider,
          integrationId: connection.id,
        });
        setFeedback({
          connectionId: connection.id,
          type: result.ok ? "success" : "error",
          message: result.message,
        });
        if (result.ok) router.refresh();
      } finally {
        setDisconnectingId(null);
      }
    });
  }

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-3">
        <InfoField label="Connected accounts" value={String(integration.connections.length)} />
        <InfoField label="Access" value={provider === "gmail" ? "Read-only" : "Read & write"} />
        <InfoField
          label="Last updated"
          value={latestRefreshLabel(
            integration.connections.map((connection) => connection.updatedAt),
          )}
        />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {integration.configured ? (
          <a
            href={`/api/integrations/${routeSegment}/start?returnTo=${encodeURIComponent(
              "/company/settings/integrations",
            )}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] hover:bg-ink/85"
          >
            <ExternalLink size={13} strokeWidth={1.9} />
            {connected ? `Connect another ${name} account` : `Connect ${name}`}
          </a>
        ) : (
          <button
            type="button"
            disabled
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-surface-active px-3 text-[12.5px] font-medium text-ink-subtle"
          >
            <ShieldAlert size={13} strokeWidth={1.9} />
            Not configured
          </button>
        )}
      </div>
      {connected ? (
        <div className="mt-4 overflow-hidden rounded-md border border-border bg-surface/55">
          {integration.connections.map((connection) => (
            <div key={connection.id} className="border-t border-border-subtle p-3 first:border-t-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[12.5px] font-semibold text-ink">
                    {connection.accountEmail ?? connection.connectionLabel}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-ink-subtle">
                    Google account - {formatDateTime(connection.updatedAt)}
                  </div>
                  {connection.status !== "connected" ? (
                    <p className="mt-1 text-[11.5px] leading-4 text-warning">
                      {connection.statusReason ?? `Reconnect ${name} to restore access.`}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {connection.status !== "connected" ? (
                    <a
                      href={`/api/integrations/${routeSegment}/start?returnTo=${encodeURIComponent(
                        "/company/settings/integrations",
                      )}`}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink hover:bg-canvas"
                    >
                      <RefreshCw size={13} strokeWidth={1.9} />
                      Reconnect
                    </a>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => disconnect(connection)}
                    disabled={isDisconnecting}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger-border bg-surface px-3 text-[12.5px] font-medium text-danger hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-65"
                  >
                    <Trash2 size={13} strokeWidth={1.9} />
                    {disconnectingId === connection.id ? "Disconnecting" : "Disconnect"}
                  </button>
                </div>
              </div>
              {feedback?.connectionId === connection.id ? (
                <p
                  className={`mt-2 text-[12px] leading-5 ${
                    feedback.type === "success" ? "text-success" : "text-danger"
                  }`}
                >
                  {feedback.message}
                </p>
              ) : null}
              {provider === "google_calendar" ? (
                <GoogleCalendarSelection connection={connection} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function calendarSelectionMap(connection: GoogleConnectionState): Record<string, boolean> {
  return Object.fromEntries(
    connection.calendars.map((calendar) => [calendar.externalId, calendar.selectedAt !== null]),
  );
}

// A value signature of the server-side selection, used to detect when props actually changed (vs a
// parent re-render with an equivalent connection object).
function calendarSelectionSignature(connection: GoogleConnectionState): string {
  return connection.calendars
    .map((calendar) => `${calendar.externalId}:${calendar.selectedAt ?? ""}`)
    .join("|");
}

function GoogleCalendarSelection({ connection }: { connection: GoogleConnectionState }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    calendarSelectionMap(connection),
  );

  // Resync from server state after router.refresh (or any external update) by adjusting state during
  // render — the React-recommended alternative to an effect. The local map is only the optimistic
  // overlay; when the server's selection actually changes it must win over stale local state.
  const [syncedSignature, setSyncedSignature] = useState(() =>
    calendarSelectionSignature(connection),
  );
  const signature = calendarSelectionSignature(connection);
  if (signature !== syncedSignature) {
    setSyncedSignature(signature);
    setSelected(calendarSelectionMap(connection));
  }

  if (connection.calendars.length === 0) return null;

  function toggle(calendarExternalId: string, next: boolean) {
    const previous = selected[calendarExternalId] ?? false;
    setSelected((current) => ({ ...current, [calendarExternalId]: next }));
    startTransition(async () => {
      try {
        const result = await setGoogleCalendarSelection({
          integrationId: connection.id,
          calendarExternalId,
          selected: next,
        });
        if (!result.ok) {
          setSelected((current) => ({ ...current, [calendarExternalId]: previous }));
          return;
        }
        router.refresh();
      } catch {
        setSelected((current) => ({ ...current, [calendarExternalId]: previous }));
      }
    });
  }

  return (
    <div className="mt-3 rounded-md border border-border-subtle bg-surface/60">
      <div className="border-b border-border-subtle px-3 py-2 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
        Calendars agents can use
      </div>
      <div className="max-h-[180px] overflow-y-auto">
        {connection.calendars.map((calendar) => (
          <label
            key={calendar.externalId}
            className="flex cursor-pointer items-center justify-between gap-3 border-t border-border-subtle px-3 py-2 first:border-t-0"
          >
            <span className="flex min-w-0 items-center gap-2">
              <input
                type="checkbox"
                checked={selected[calendar.externalId] ?? false}
                disabled={isPending || calendar.status !== "available"}
                onChange={(event) => toggle(calendar.externalId, event.target.checked)}
                className="h-3.5 w-3.5 accent-ink"
              />
              <span className="truncate text-[12.5px] font-medium text-ink">{calendar.name}</span>
              {calendar.primary ? (
                <span className="rounded-full border border-border bg-canvas px-1.5 py-0.5 text-[10px] font-medium text-ink-subtle">
                  Primary
                </span>
              ) : null}
            </span>
            {calendar.status !== "available" ? (
              <span
                className={`rounded border px-1.5 py-0.5 text-[10.5px] font-medium ${resourceStatusClass(
                  calendar.status,
                )}`}
              >
                {resourceStatusLabel(calendar.status)}
              </span>
            ) : null}
          </label>
        ))}
      </div>
    </div>
  );
}

function neonSelectionMap(connection: NeonConnection): Record<string, boolean> {
  return Object.fromEntries(
    connection.databases.map((database) => [database.id, database.selectedAt !== null]),
  );
}

function neonSelectionSignature(connection: NeonConnection): string {
  return connection.databases
    .map((database) => `${database.id}:${database.selectedAt ?? ""}`)
    .join("|");
}

function NeonDatabaseSelection({ connection }: { connection: NeonConnection }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    neonSelectionMap(connection),
  );
  const [syncedSignature, setSyncedSignature] = useState(() => neonSelectionSignature(connection));
  const signature = neonSelectionSignature(connection);
  if (signature !== syncedSignature) {
    setSyncedSignature(signature);
    setSelected(neonSelectionMap(connection));
  }

  if (connection.databases.length === 0) {
    return (
      <p className="mt-3 rounded-md border border-border-subtle bg-surface/60 px-3 py-2 text-[12px] text-ink-muted">
        No databases are visible to this Neon API key.
      </p>
    );
  }

  function toggle(resourceId: string, next: boolean) {
    const previous = selected[resourceId] ?? false;
    setSelected((current) => ({ ...current, [resourceId]: next }));
    startTransition(async () => {
      try {
        const result = await setNeonDatabaseSelectionAction({ resourceId, selected: next });
        if (!result.ok) {
          setSelected((current) => ({ ...current, [resourceId]: previous }));
          return;
        }
        router.refresh();
      } catch {
        setSelected((current) => ({ ...current, [resourceId]: previous }));
      }
    });
  }

  return (
    <div className="mt-3 rounded-md border border-border-subtle bg-surface/60">
      <div className="border-b border-border-subtle px-3 py-2 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
        Databases agents can use
      </div>
      <div className="max-h-[220px] overflow-y-auto">
        {connection.databases.map((database) => (
          <label
            key={database.id}
            className="flex cursor-pointer items-center justify-between gap-3 border-t border-border-subtle px-3 py-2 first:border-t-0"
          >
            <span className="flex min-w-0 items-center gap-2">
              <input
                type="checkbox"
                checked={selected[database.id] ?? false}
                disabled={isPending || database.status !== "available"}
                onChange={(event) => toggle(database.id, event.target.checked)}
                className="h-3.5 w-3.5 accent-ink"
              />
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-medium text-ink">
                  {database.displayName}
                </span>
                <span className="block truncate text-[11.5px] text-ink-subtle">
                  {database.metadata.branchName ?? database.metadata.branchId} /{" "}
                  {database.metadata.databaseName} / {database.metadata.roleName}
                </span>
              </span>
            </span>
            {database.status !== "available" ? (
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[10.5px] font-medium ${resourceStatusClass(
                  database.status,
                )}`}
              >
                {resourceStatusLabel(database.status)}
              </span>
            ) : null}
          </label>
        ))}
      </div>
    </div>
  );
}

function SaveNeonButton({ connected }: { connected: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-65"
    >
      <ExternalLink size={13} strokeWidth={1.9} />
      {pending ? "Connecting" : connected ? "Update key" : "Connect Neon"}
    </button>
  );
}

function RefreshNeonButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-65"
    >
      <RefreshCw size={13} strokeWidth={1.9} />
      {pending ? "Refreshing" : "Refresh"}
    </button>
  );
}

function RefreshRepositoriesButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-65"
    >
      <RefreshCw size={13} strokeWidth={1.9} />
      {pending ? "Refreshing" : "Refresh"}
    </button>
  );
}

function DisconnectGitHubDialog({
  connection,
  isPending,
  onCancel,
  onConfirm,
}: {
  connection: GitHubConnection | null;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    if (!connection) return;

    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancelRef.current();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [connection]);

  if (!connection) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 px-4 py-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="disconnect-github-title"
        className="w-full max-w-[420px] rounded-lg border border-black/[0.1] bg-surface-raised shadow-[0_24px_64px_rgba(0,0,0,0.22),0_4px_14px_rgba(0,0,0,0.12)]"
      >
        <div className="border-b border-black/[0.08] px-4 py-3">
          <h2 id="disconnect-github-title" className="text-[14px] font-semibold text-ink">
            Uninstall GitHub App
          </h2>
        </div>
        <div className="px-4 py-4">
          <p className="text-[13px] leading-5 text-ink-muted">
            Uninstall the GitHub App for {connection.connectionLabel} and remove its repositories
            from this workspace?
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-black/[0.08] px-4 py-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="inline-flex h-8 items-center rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-65"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger-border bg-danger-bg px-3 text-[12.5px] font-medium text-danger hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-65"
          >
            <Trash2 size={13} strokeWidth={1.9} />
            Uninstall
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
        {label}
      </div>
      <div className="mt-1 truncate text-[12.5px] font-medium text-ink">{value}</div>
    </div>
  );
}

function integrationState(
  provider: IntegrationProviderId,
  integrations: WorkspaceIntegrationState,
): IntegrationCardState {
  switch (provider) {
    case "github":
      return githubIntegrationState(integrations.github.status);
    case "neon":
      return neonIntegrationState(integrations.neon.status);
    case "gmail":
      return googleIntegrationState(integrations.gmail.status, "Gmail");
    case "google_calendar":
      return googleIntegrationState(integrations.google_calendar.status, "Google Calendar");
    case "google_drive":
      return googleIntegrationState(integrations.google_drive.status, "Google Drive");
  }
  return assertNever(provider);
}

function googleIntegrationState(status: IntegrationStatus, name: string): IntegrationCardState {
  if (status === "connected") {
    return { status: "connected", label: "Connected", description: `${name} is connected.` };
  }
  if (status === "needs_reauth") {
    return {
      status: "needs_reauth",
      label: "Needs reauth",
      description: `A ${name} account needs to be reconnected.`,
    };
  }
  if (status === "sync_failed") {
    return {
      status: "sync_failed",
      label: "Sync failed",
      description: `${name} sync failed.`,
    };
  }
  if (status === "error") {
    return {
      status: "error",
      label: "Not configured",
      description: `${name} OAuth client is not configured.`,
    };
  }
  return {
    status: "not_connected",
    label: "Available",
    description: `Connect ${name} to let agents use it.`,
  };
}

function neonIntegrationState(status: IntegrationStatus): IntegrationCardState {
  if (status === "connected") {
    return { status: "connected", label: "Connected", description: "Neon is connected." };
  }
  if (status === "needs_repository_access") {
    return {
      status: "needs_repository_access",
      label: "Needs databases",
      description: "Neon is connected but no databases are selected.",
    };
  }
  if (status === "needs_reauth") {
    return {
      status: "needs_reauth",
      label: "Needs key",
      description: "The Neon API key needs to be replaced.",
    };
  }
  if (status === "sync_failed") {
    return {
      status: "sync_failed",
      label: "Sync failed",
      description: "Neon database sync failed.",
    };
  }
  return {
    status: "not_connected",
    label: "Available",
    description: "Connect Neon to let agents use selected Postgres databases.",
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported integration provider: ${value}`);
}

function githubIntegrationState(status: IntegrationStatus): IntegrationCardState {
  if (status === "connected") {
    return {
      status: "connected" as const,
      label: "Connected",
      description: "GitHub is connected.",
    };
  }
  if (status === "needs_repository_access") {
    return {
      status: "needs_repository_access" as const,
      label: "Needs access",
      description:
        "GitHub is installed, but no repositories have been granted to it yet. Add repositories in GitHub via Configure, then click Refresh.",
    };
  }
  if (status === "needs_reauth") {
    return {
      status: "needs_reauth" as const,
      label: "Needs reauth",
      description: "A GitHub connection needs to be reauthorized.",
    };
  }
  if (status === "sync_failed") {
    return {
      status: "sync_failed" as const,
      label: "Sync failed",
      description: "GitHub repository sync failed.",
    };
  }
  if (status === "error") {
    return {
      status: "error" as const,
      label: "Not configured",
      description: "GitHub App settings are missing.",
    };
  }
  return {
    status: "not_connected" as const,
    label: "Available",
    description: "Connect GitHub to use work repositories.",
  };
}

function statusClass(status: IntegrationStatus | "disconnected") {
  if (status === "connected") return "border-success-border bg-success-bg text-success";
  if (
    status === "needs_repository_access" ||
    status === "needs_reauth" ||
    status === "sync_failed" ||
    status === "error"
  ) {
    return "border-warning-border bg-warning-bg text-warning";
  }
  return "border-border bg-surface text-ink-muted";
}

function integrationStatusLabel(status: IntegrationStatus | "disconnected") {
  if (status === "needs_reauth") return "Needs reauth";
  if (status === "sync_failed") return "Sync failed";
  if (status === "disconnected") return "Disconnected";
  if (status === "connected") return "Connected";
  if (status === "needs_repository_access") return "Needs access";
  if (status === "error") return "Not configured";
  return "Available";
}

function integrationStatusDescription(status: IntegrationStatus | "disconnected") {
  if (status === "needs_reauth") return "Reconnect GitHub to restore access.";
  if (status === "sync_failed") return "Refresh or reconnect GitHub to restore sync.";
  if (status === "disconnected") return "This GitHub connection was disconnected.";
  return "GitHub needs attention.";
}

function resourceStatusLabel(status: ResourceStatus) {
  if (status === "permission_lost") return "Permission lost";
  if (status === "archived") return "Archived";
  if (status === "sync_failed") return "Sync failed";
  return "Available";
}

function resourceStatusClass(status: ResourceStatus) {
  if (status === "available") return "border-success-border bg-success-bg text-success";
  return "border-warning-border bg-warning-bg text-warning";
}

function filterLabel(filter: Filter) {
  if (filter === "connected") return "Connected";
  if (filter === "available") return "Available";
  if (filter === "needs_attention") return "Needs attention";
  return "All";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function latestRefreshLabel(values: string[]) {
  const latest = values
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  return latest ? formatDateTime(new Date(latest).toISOString()) : "Never";
}
