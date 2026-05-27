"use client";

import {
  CheckCircle2,
  ExternalLink,
  GitBranch,
  type LucideIcon,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import {
  disconnectGitHubIntegrationAction,
  refreshGitHubRepositories,
} from "@/lib/integrations/actions";

type IntegrationStatus =
  | "not_connected"
  | "connected"
  | "needs_repository_access"
  | "needs_reauth"
  | "sync_failed"
  | "error";
type ResourceStatus = "available" | "permission_lost" | "archived" | "sync_failed";
type IntegrationProviderId = "github";

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
};
type GitHubConnection = WorkspaceIntegrationState["github"]["connections"][number];
type DisconnectFeedback = {
  connectionId: string;
  type: "success" | "error";
  message: string;
};

type IntegrationDefinition = {
  id: IntegrationProviderId;
  name: string;
  category: "Code";
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
];

export default function IntegrationsView({
  integrations,
}: {
  integrations: WorkspaceIntegrationState;
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
          <div className="flex h-8 min-w-[260px] flex-1 items-center gap-2 rounded-md border border-[#e3e3df] bg-white/70 px-2.5">
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
                  ? "border-ink/20 bg-ink text-white"
                  : "border-[#e3e3df] bg-white/65 text-ink-muted hover:bg-white"
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
}: {
  integration: IntegrationDefinition;
  state: IntegrationCardState;
  integrations: WorkspaceIntegrationState;
}) {
  const Icon = integration.icon;
  const StatusIcon = state.status === "connected" ? CheckCircle2 : ShieldAlert;

  return (
    <section className="rounded-lg border border-[#e3e3df] bg-white/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[#e6e6e3] bg-[#f7f7f5] text-ink-muted">
            <Icon size={17} strokeWidth={1.85} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[13.5px] font-semibold tracking-[-0.005em] text-ink">
                {integration.name}
              </h2>
              <span className="rounded-full border border-[#e5e5e1] bg-[#f7f7f4] px-2 py-0.5 text-[10.5px] font-medium text-ink-subtle">
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

      <div className="mt-4 border-t border-[#ecece8] pt-4">
        <IntegrationControls provider={integration.id} integrations={integrations} />
      </div>
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
              "/settings/integrations",
            )}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#111] px-3 text-[12.5px] font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] hover:bg-black"
          >
            <ExternalLink size={13} strokeWidth={1.9} />
            {connected ? "Connect another GitHub account" : "Connect GitHub"}
          </a>
        ) : (
          <button
            type="button"
            disabled
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#d9d9d4] px-3 text-[12.5px] font-medium text-ink-subtle"
          >
            <ShieldAlert size={13} strokeWidth={1.9} />
            Not configured
          </button>
        )}
      </div>
      {integration.connections.length > 0 ? (
        <div className="mt-4 overflow-hidden rounded-md border border-[#e6e6e3] bg-white/55">
          {integration.connections.map((connection) => (
            <div key={connection.id} className="border-t border-[#ecece8] p-3 first:border-t-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[12.5px] font-semibold text-ink">
                    {connection.connectionLabel}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-ink-subtle">
                    {connection.accountType ?? "Account"} - {formatDateTime(connection.updatedAt)}
                  </div>
                  {connection.status !== "connected" ? (
                    <p className="mt-1 text-[11.5px] leading-4 text-[#795b19]">
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
                  <form action={refreshGitHubRepositories.bind(null, connection.id)}>
                    <RefreshRepositoriesButton />
                  </form>
                  <button
                    type="button"
                    onClick={() => requestDisconnectGitHub(connection)}
                    disabled={isDisconnecting}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#efd0ca] bg-white px-3 text-[12.5px] font-medium text-[#9f2f24] hover:bg-[#fff7f5] disabled:cursor-not-allowed disabled:opacity-65"
                  >
                    <Trash2 size={13} strokeWidth={1.9} />
                    {disconnectingConnectionId === connection.id ? "Uninstalling" : "Uninstall"}
                  </button>
                </div>
              </div>
              {disconnectFeedback?.connectionId === connection.id ? (
                <p
                  className={`mt-2 text-[12px] leading-5 ${
                    disconnectFeedback.type === "success" ? "text-[#216b35]" : "text-[#9f2f24]"
                  }`}
                >
                  {disconnectFeedback.message}
                </p>
              ) : null}
              {connection.repositories.length > 0 ? (
                <div className="mt-3 max-h-[150px] overflow-y-auto rounded-md border border-[#eeeeea] bg-white/60">
                  {connection.repositories.map((repository) => (
                    <div
                      key={`${connection.id}:${repository.fullName}`}
                      className="border-t border-[#eeeeea] px-3 py-2 first:border-t-0"
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

function RefreshRepositoriesButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#e3e3df] bg-white px-3 text-[12.5px] font-medium text-ink hover:bg-[#f7f7f5] disabled:cursor-not-allowed disabled:opacity-65"
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
  onCancelRef.current = onCancel;

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="disconnect-github-title"
        className="w-full max-w-[420px] rounded-lg border border-black/[0.1] bg-[#fbfbfa] shadow-[0_24px_64px_rgba(0,0,0,0.22),0_4px_14px_rgba(0,0,0,0.12)]"
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
            className="inline-flex h-8 items-center rounded-md border border-[#deded9] bg-white px-3 text-[12.5px] font-medium text-ink hover:bg-[#f5f5f1] disabled:cursor-not-allowed disabled:opacity-65"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#efd0ca] bg-[#fff7f5] px-3 text-[12.5px] font-medium text-[#9f2f24] hover:bg-[#fff0ed] disabled:cursor-not-allowed disabled:opacity-65"
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
  }
  return assertNever(provider);
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
      description: "GitHub is installed but no repositories are available.",
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
  if (status === "connected") return "border-[#cfe5d5] bg-[#f0f8f2] text-[#216b35]";
  if (
    status === "needs_repository_access" ||
    status === "needs_reauth" ||
    status === "sync_failed" ||
    status === "error"
  ) {
    return "border-[#eadcb6] bg-[#fff8e7] text-[#795b19]";
  }
  return "border-[#e3e3df] bg-white text-ink-muted";
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
  if (status === "available") return "border-[#cfe5d5] bg-[#f0f8f2] text-[#216b35]";
  return "border-[#eadcb6] bg-[#fff8e7] text-[#795b19]";
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
