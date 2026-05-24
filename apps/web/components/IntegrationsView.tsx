"use client";

import {
  CheckCircle2,
  ExternalLink,
  GitBranch,
  RefreshCw,
  Search,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { refreshGitHubRepositories } from "@/lib/integrations/actions";

type IntegrationStatus = "not_connected" | "connected" | "needs_repository_access" | "error";

type WorkspaceIntegrationState = {
  github: {
    status: IntegrationStatus;
    installation: {
      installationId: string;
      accountLogin: string | null;
      accountType: string | null;
      updatedAt: string;
    } | null;
    repositories: Array<{
      fullName: string;
      defaultBranch: string;
      selectedAt: string | null;
    }>;
  };
};

type IntegrationDefinition = {
  id: "github";
  name: string;
  category: "Code";
  description: string;
  icon: LucideIcon;
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
        const state = integrationState(integrations);
        const matchesQuery =
          normalized.length === 0 ||
          integration.name.toLowerCase().includes(normalized) ||
          integration.description.toLowerCase().includes(normalized);
        const matchesFilter =
          filter === "all" ||
          (filter === "connected" && state.status === "connected") ||
          (filter === "available" && state.status === "not_connected") ||
          (filter === "needs_attention" &&
            (state.status === "needs_repository_access" || state.status === "error"));

        return matchesQuery && matchesFilter;
      }),
    [filter, integrations, query],
  );

  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-8 pb-24 pt-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">
              Integrations
            </h1>
            <p className="mt-1 max-w-[560px] text-[13px] leading-5 tracking-[-0.005em] text-ink-muted">
              Connect external resources agents can access. Platform-supported tools such as AMP
              are enabled from agent configuration instead of user-supplied credentials.
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
                state={integrationState(integrations)}
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
  state: { status: IntegrationStatus; label: string; description: string };
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
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${statusClass(
            state.status,
          )}`}
        >
          <StatusIcon size={11} strokeWidth={2} />
          {state.label}
        </span>
      </div>

      <div className="mt-4 border-t border-[#ecece8] pt-4">
        <GitHubControls integrations={integrations} />
      </div>
    </section>
  );
}

function GitHubControls({ integrations }: { integrations: WorkspaceIntegrationState }) {
  const connected = Boolean(integrations.github.installation);
  const configured = integrations.github.status !== "error";
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-3">
        <InfoField
          label="Account"
          value={integrations.github.installation?.accountLogin ?? "Not connected"}
        />
        <InfoField label="Repositories" value={String(integrations.github.repositories.length)} />
        <InfoField
          label="Last refresh"
          value={
            integrations.github.installation
              ? formatDateTime(integrations.github.installation.updatedAt)
              : "Never"
          }
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
            {connected ? "Reconnect" : "Connect GitHub"}
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
        {connected ? (
          <form action={refreshGitHubRepositories}>
            <button
              type="submit"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#e3e3df] bg-white px-3 text-[12.5px] font-medium text-ink hover:bg-[#f7f7f5]"
            >
              <RefreshCw size={13} strokeWidth={1.9} />
              Refresh repositories
            </button>
          </form>
        ) : null}
      </div>
      {integrations.github.repositories.length > 0 ? (
        <div className="mt-4 max-h-[180px] overflow-y-auto rounded-md border border-[#e6e6e3] bg-white/55">
          {integrations.github.repositories.map((repository) => (
            <div
              key={repository.fullName}
              className="flex items-center justify-between gap-4 border-t border-[#ecece8] px-3 py-2 first:border-t-0"
            >
              <span className="truncate text-[12.5px] font-medium text-ink">
                {repository.fullName}
              </span>
              <span className="shrink-0 text-[11.5px] text-ink-subtle">
                {repository.defaultBranch}
              </span>
            </div>
          ))}
        </div>
      ) : null}
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

function integrationState(integrations: WorkspaceIntegrationState) {
  if (integrations.github.status === "connected") {
    return {
      status: "connected" as const,
      label: "Connected",
      description: "GitHub is connected.",
    };
  }
  if (integrations.github.status === "needs_repository_access") {
    return {
      status: "needs_repository_access" as const,
      label: "Needs access",
      description: "GitHub is installed but no repositories are available.",
    };
  }
  if (integrations.github.status === "error") {
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

function statusClass(status: IntegrationStatus) {
  if (status === "connected") return "border-[#cfe5d5] bg-[#f0f8f2] text-[#216b35]";
  if (status === "needs_repository_access" || status === "error") {
    return "border-[#eadcb6] bg-[#fff8e7] text-[#795b19]";
  }
  return "border-[#e3e3df] bg-white text-ink-muted";
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
