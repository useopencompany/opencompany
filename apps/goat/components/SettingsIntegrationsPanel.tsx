"use client";

import type { GoatMcpClient } from "@opencompany/db/goat-schema";
import { type LucideIcon as IconComponent, SlackIcon } from "@opencompany/ui/icons";
import { useLiveQuery } from "@tanstack/react-db";
import {
  CalendarDays,
  Code2,
  Files,
  FileText,
  GitBranch,
  ListTodo,
  Mail,
  PlugZap,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useHydrated } from "@/components/useHydrated";
import {
  disconnectGoatCodexAuth,
  type GoatCodexDeviceAuthFlow,
  pollGoatCodexDeviceAuth,
  startGoatCodexDeviceAuth,
} from "@/lib/codex-auth";
import {
  disconnectGoatIntegrationAccountAction,
  getGoatIntegrationAccountUsageAction,
} from "@/lib/integration-account-actions";
import {
  type GoatCodexProviderState,
  type GoatGitHubProviderState,
  type GoatGoogleProviderState,
  type GoatIntegrationAccountView,
  type GoatIntegrationState,
  type GoatJamieProviderState,
  type GoatLinearProviderState,
  type GoatPersonalAccountProvider,
  type GoatSlackProviderState,
  goatIntegrationStateFromRows,
} from "@/lib/integration-state";
import { createGoatCollections, type GoatIntegrationRow } from "@/lib/task-collections";

export function SettingsIntegrationsPanel({
  initialIntegrations,
  isWorkspaceAdmin,
  mcpSetup,
}: {
  initialIntegrations: GoatIntegrationState;
  isWorkspaceAdmin: boolean;
  mcpSetup: GoatMcpSetupView;
}) {
  const hydrated = useHydrated();
  if (!hydrated) {
    return (
      <IntegrationRows
        integrations={initialIntegrations}
        isWorkspaceAdmin={isWorkspaceAdmin}
        mcpSetup={mcpSetup}
      />
    );
  }
  return (
    <LiveSettingsIntegrations
      initialIntegrations={initialIntegrations}
      isWorkspaceAdmin={isWorkspaceAdmin}
      mcpSetup={mcpSetup}
    />
  );
}

function LiveSettingsIntegrations({
  initialIntegrations,
  isWorkspaceAdmin,
  mcpSetup,
}: {
  initialIntegrations: GoatIntegrationState;
  isWorkspaceAdmin: boolean;
  mcpSetup: GoatMcpSetupView;
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  const { data: rows, isLoading } = useLiveQuery((q) =>
    q.from({ integration: collections.integrations }),
  );
  const integrations = useMemo(() => {
    if (isLoading && !rows?.length) return initialIntegrations;
    const liveIntegrations = goatIntegrationStateFromRows((rows ?? []) as GoatIntegrationRow[]);
    return {
      ...liveIntegrations,
      codex: initialIntegrations.codex,
      jamie: {
        ...liveIntegrations.jamie,
        integrationId: initialIntegrations.jamie.integrationId,
        webhookUrl: initialIntegrations.jamie.webhookUrl,
        apiKeyConfigured: initialIntegrations.jamie.apiKeyConfigured,
      },
    };
  }, [initialIntegrations, isLoading, rows]);

  return (
    <IntegrationRows
      integrations={integrations}
      isWorkspaceAdmin={isWorkspaceAdmin}
      mcpSetup={mcpSetup}
    />
  );
}

function IntegrationRows({
  integrations,
  isWorkspaceAdmin,
  mcpSetup,
}: {
  integrations: GoatIntegrationState;
  isWorkspaceAdmin: boolean;
  mcpSetup: GoatMcpSetupView;
}) {
  return (
    <>
      <section className="flex flex-col gap-1">
        <h2 className="mb-0.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Workspace
        </h2>
        <p className="mb-1 px-2 text-[12px] leading-5 text-ink-subtle">
          Shared connections that feed the brains in this workspace.
          {isWorkspaceAdmin ? "" : " Managed by workspace admins."}
        </p>
        <IntegrationRow
          icon={GitBranch}
          label="GitHub"
          integration={integrations.github}
          canConnect={isWorkspaceAdmin}
        />
        <IntegrationRow
          icon={FileText}
          label="Jamie"
          integration={integrations.jamie}
          canConnect={isWorkspaceAdmin}
        />
      </section>
      <section className="mt-4 flex flex-col gap-1">
        <h2 className="mb-0.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Personal
        </h2>
        <p className="mb-1 px-2 text-[12px] leading-5 text-ink-subtle">
          Connections that act as you. Only you can manage them or wire them into brains.
        </p>
        <IntegrationProviderGroup
          icon={Mail}
          label="Gmail"
          provider="gmail"
          accounts={integrations.personalAccounts.gmail}
        />
        <IntegrationProviderGroup
          icon={CalendarDays}
          label="Google Calendar"
          provider="google_calendar"
          accounts={integrations.personalAccounts.google_calendar}
        />
        <IntegrationProviderGroup
          icon={Files}
          label="Google Drive"
          provider="google_drive"
          accounts={integrations.personalAccounts.google_drive}
        />
        <IntegrationProviderGroup
          icon={ListTodo}
          label="Linear"
          provider="linear"
          accounts={integrations.personalAccounts.linear}
        />
        <IntegrationProviderGroup
          icon={SlackIcon}
          label="Slack"
          provider="slack"
          accounts={integrations.personalAccounts.slack}
        />
        <McpIntegrationRow setup={mcpSetup} />
        <CodexIntegrationRow integration={integrations.codex} />
      </section>
    </>
  );
}

type GoatMcpSetupView = {
  preferredClient: GoatMcpClient | null;
  completedAt: string | null;
};

const MCP_CLIENT_LABELS: Record<GoatMcpClient, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  cursor: "Cursor",
};

function McpIntegrationRow({ setup }: { setup: GoatMcpSetupView }) {
  const clientLabel = setup.preferredClient ? MCP_CLIENT_LABELS[setup.preferredClient] : null;
  const detail = setup.completedAt
    ? clientLabel
      ? `Connected with ${clientLabel}`
      : "Connected"
    : clientLabel
      ? `Continue setup for ${clientLabel}`
      : "Claude, ChatGPT, or Cursor";

  return (
    <Link
      href="/settings/mcp"
      className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <PlugZap size={16} strokeWidth={2} className="shrink-0 text-ink-subtle" />
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="min-w-0">
          <span className="block truncate text-[14px] font-medium leading-tight text-ink">
            Goat MCP
          </span>
          <span className="block truncate text-[12px] leading-4 text-ink-subtle">{detail}</span>
        </div>
        <span className="ml-auto shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
          {setup.completedAt ? "Connected" : "Set up"}
        </span>
      </div>
    </Link>
  );
}

function IntegrationRow({
  icon: Icon,
  label,
  integration,
  canConnect = true,
}: {
  // Lucide icons and @opencompany/ui brand icons share this prop surface.
  icon: IconComponent;
  label: string;
  integration:
    | GoatGoogleProviderState
    | GoatLinearProviderState
    | GoatGitHubProviderState
    | GoatJamieProviderState
    | GoatSlackProviderState;
  // Workspace-owned integrations render read-only for non-admin members.
  canConnect?: boolean;
}) {
  const status = integrationStatus(integration);
  const connectHref = integrationConnectHref(integration.provider);
  const accountLabel =
    integration.provider === "linear"
      ? integration.accountName
      : integration.provider === "github"
        ? integration.accountName
        : integration.provider === "jamie"
          ? integration.accountName
          : integration.provider === "slack"
            ? [integration.teamName, integration.accountName].filter(Boolean).join(" · ") || null
            : (integration.accountEmail ?? integration.accountName);

  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2">
      <Icon size={16} strokeWidth={2} className="shrink-0 text-ink-subtle" />
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="min-w-0">
          <span className="block truncate text-[14px] font-medium leading-tight text-ink">
            {label}
          </span>
          {accountLabel ? (
            <span className="block truncate text-[12px] leading-4 text-ink-subtle">
              {accountLabel}
            </span>
          ) : null}
        </div>
        {status === "Connected" || !canConnect ? (
          <span className="ml-auto shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
            {status === "Connected" ? status : "Not connected"}
          </span>
        ) : (
          <a
            href={connectHref}
            className="ml-auto shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            {status}
          </a>
        )}
      </div>
    </div>
  );
}

// A personal provider with any number of connected accounts. Zero accounts
// renders exactly like the classic single row; with accounts, each connection
// gets its own row (identity + status + disconnect) plus an "Add account"
// affordance — a second OAuth pass creates a second integration row.
function IntegrationProviderGroup({
  icon: Icon,
  label,
  provider,
  accounts,
}: {
  icon: IconComponent;
  label: string;
  provider: GoatPersonalAccountProvider;
  accounts: GoatIntegrationAccountView[];
}) {
  const connectHref = integrationConnectHref(provider);
  if (accounts.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-lg px-2 py-2">
        <Icon size={16} strokeWidth={2} className="shrink-0 text-ink-subtle" />
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="block truncate text-[14px] font-medium leading-tight text-ink">
            {label}
          </span>
          <a
            href={connectHref}
            className="ml-auto shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            Connect
          </a>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col rounded-lg px-2 py-2">
      <div className="flex items-center gap-3">
        <Icon size={16} strokeWidth={2} className="shrink-0 text-ink-subtle" />
        <span className="block truncate text-[14px] font-medium leading-tight text-ink">
          {label}
        </span>
        <a
          href={connectHref}
          className="ml-auto shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          Add account
        </a>
      </div>
      <div className="mt-1 flex flex-col gap-0.5 pl-7">
        {accounts.map((account) => (
          <IntegrationAccountRow key={account.integrationId} account={account} />
        ))}
      </div>
    </div>
  );
}

function IntegrationAccountRow({ account }: { account: GoatIntegrationAccountView }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<{ affectedBrainSourceCount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const identity =
    account.provider === "slack"
      ? [account.connectionLabel, account.accountName].filter(Boolean).join(" · ") ||
        account.accountEmail ||
        account.integrationId
      : account.provider === "linear"
        ? account.connectionLabel || account.accountName || account.integrationId
        : account.accountEmail || account.accountName || account.integrationId;

  const beginDisconnect = () => {
    setError(null);
    startTransition(async () => {
      const usage = await getGoatIntegrationAccountUsageAction(account.integrationId);
      if (!usage.ok) {
        setError(usage.error);
        return;
      }
      if (usage.affectedBrainSourceCount > 0) {
        setConfirming({ affectedBrainSourceCount: usage.affectedBrainSourceCount });
        return;
      }
      const result = await disconnectGoatIntegrationAccountAction(account.integrationId);
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  };

  const confirmDisconnect = () => {
    setError(null);
    startTransition(async () => {
      const result = await disconnectGoatIntegrationAccountAction(account.integrationId);
      if (!result.ok) setError(result.error);
      else {
        setConfirming(null);
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex min-w-0 items-center gap-3">
        <span className="block truncate text-[12px] leading-4 text-ink-subtle">{identity}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {account.connected ? (
            <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
              Connected
            </span>
          ) : (
            <a
              href={integrationConnectHref(account.provider)}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
            >
              Reconnect
            </a>
          )}
          <button
            type="button"
            onClick={beginDisconnect}
            disabled={isPending}
            className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-60"
          >
            Disconnect
          </button>
        </div>
      </div>
      {confirming ? (
        <div className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-[12px] leading-5 text-ink-muted">
          <span>
            Disconnect {identity}? {confirming.affectedBrainSourceCount} brain source
            {confirming.affectedBrainSourceCount === 1 ? "" : "s"} fed by this account will stop
            ingesting.
          </span>
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              onClick={confirmDisconnect}
              disabled={isPending}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-warning transition-colors duration-150 hover:bg-surface-hover disabled:opacity-60"
            >
              Disconnect account
            </button>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              disabled={isPending}
              className="rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error ? <div className="text-[12px] leading-4 text-warning">{error}</div> : null}
    </div>
  );
}

function CodexIntegrationRow({ integration }: { integration: GoatCodexProviderState }) {
  const router = useRouter();
  const [flow, setFlow] = useState<GoatCodexDeviceAuthFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [isPending, startTransition] = useTransition();
  const status = flow?.status ?? integration.status;

  useEffect(() => {
    if (
      !flow ||
      flow.status === "completed" ||
      flow.status === "failed" ||
      flow.status === "expired"
    ) {
      return;
    }

    let active = true;
    let pollInFlight = false;
    const timer = window.setInterval(() => {
      if (pollInFlight) return;
      pollInFlight = true;
      setIsPolling(true);
      void (async () => {
        try {
          const result = await pollGoatCodexDeviceAuth(flow.id);
          if (!active) return;
          if (result.ok) {
            if (result.flow.status === "completed") {
              setFlow(null);
              setError(null);
              router.refresh();
            } else {
              setFlow(result.flow);
            }
          } else {
            setError(result.error);
          }
        } finally {
          pollInFlight = false;
          if (active) setIsPolling(false);
        }
      })();
    }, 2500);

    return () => {
      active = false;
      window.clearInterval(timer);
      setIsPolling(false);
    };
  }, [flow, router]);

  const startAuth = () => {
    setError(null);
    startTransition(async () => {
      const result = await startGoatCodexDeviceAuth();
      if (result.ok) {
        if (result.flow.status === "completed") {
          setFlow(null);
          router.refresh();
        } else {
          setFlow(result.flow);
        }
      } else {
        setError(result.error);
      }
    });
  };

  const disconnect = () => {
    setError(null);
    setIsPolling(false);
    startTransition(async () => {
      await disconnectGoatCodexAuth();
      setFlow(null);
      router.refresh();
    });
  };

  const accountLabel =
    integration.status === "connected"
      ? integration.lastValidatedAt
        ? `Validated ${formatDateTime(integration.lastValidatedAt)}`
        : "Subscription connected"
      : integration.statusReason;

  return (
    <div className="flex items-start gap-3 rounded-lg px-2 py-2">
      <Code2 size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-ink-subtle" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <span className="block truncate text-[14px] font-medium leading-tight text-ink">
              Codex
            </span>
            {accountLabel ? (
              <span className="block truncate text-[12px] leading-4 text-ink-subtle">
                {accountLabel}
              </span>
            ) : null}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {integration.connected ? (
              <button
                type="button"
                onClick={disconnect}
                disabled={isPending}
                className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-60"
              >
                Disconnect
              </button>
            ) : null}
            <button
              type="button"
              onClick={startAuth}
              disabled={isPending}
              aria-busy={isPending || isPolling}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-60"
            >
              {buttonLabel(status, isPending)}
            </button>
          </div>
        </div>
        {flow?.status === "code_ready" && flow.verificationUri && flow.userCode ? (
          <div className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-[12px] leading-5 text-ink-muted">
            <a
              href={flow.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-ink underline underline-offset-2"
            >
              Open Codex sign-in
            </a>
            <span> and enter </span>
            <span className="font-mono font-semibold text-ink">{flow.userCode}</span>
          </div>
        ) : null}
        {flow?.statusReason || error ? (
          <div className="text-[12px] leading-4 text-warning">{error ?? flow?.statusReason}</div>
        ) : null}
      </div>
    </div>
  );
}

function integrationStatus(
  integration:
    | GoatGoogleProviderState
    | GoatLinearProviderState
    | GoatGitHubProviderState
    | GoatJamieProviderState
    | GoatSlackProviderState,
) {
  if (integration.status === "connected") return "Connected";
  if (integration.provider === "jamie" && integration.apiKeyConfigured) return "Connected";
  if (integration.provider === "jamie" && integration.status === "needs_reauth")
    return "Finish setup";
  if (integration.status === "needs_reauth" || integration.status === "sync_failed") {
    return "Reconnect";
  }
  return "Connect";
}

function integrationConnectHref(
  provider: GoatGoogleProviderState["provider"] | "linear" | "github" | "jamie" | "slack",
) {
  if (provider === "gmail") return "/api/integrations/gmail/start?returnTo=/settings/integrations";
  if (provider === "google_calendar") {
    return "/api/integrations/google-calendar/start?returnTo=/settings/integrations";
  }
  if (provider === "google_drive") {
    return "/api/integrations/google-drive/start?returnTo=/settings/integrations";
  }
  if (provider === "github")
    return "/api/integrations/github/start?returnTo=/settings/integrations";
  if (provider === "jamie") return "/settings/jamie";
  if (provider === "slack") return "/api/integrations/slack/start?returnTo=/settings/integrations";
  return "/api/integrations/linear/start?returnTo=/settings/integrations";
}

function buttonLabel(status: string, isPending: boolean) {
  if (isPending) return "Working";
  if (status === "connected") return "Reconnect";
  if (status === "needs_reauth") return "Reconnect";
  if (status === "failed" || status === "expired") return "Retry";
  return "Connect";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
