"use client";

import type { GoatMcpClient } from "@opencompany/db/goat-schema";
import { toast } from "@opencompany/ui/components/sonner";
import {
  AttioIcon,
  FathomIcon,
  GitHubIcon,
  GmailIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  GranolaIcon,
  HubSpotIcon,
  type LucideIcon as IconComponent,
  LinearIcon,
  OpenAIIcon,
  OpenCompanyMark,
  SlackIcon,
} from "@opencompany/ui/icons";
import { cn } from "@opencompany/ui/lib/utils";
import { useLiveQuery } from "@tanstack/react-db";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState, useTransition } from "react";
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
import {
  goatIntegrationConnectionError,
  goatIntegrationConnectionSuccess,
} from "@/lib/onboarding-integrations";
import { createGoatCollections, type GoatIntegrationRow } from "@/lib/task-collections";

// Presentation metadata for each integration card: the real brand logo (or a
// monogram fallback where no square vector mark exists), the colored logo tile,
// and a short connection-focused description. Keyed by provider so the card
// components derive everything from the provider string.
type IntegrationMetaKey = GoatPersonalAccountProvider | "github" | "jamie" | "mcp" | "codex";

type IntegrationMeta = {
  label: string;
  description: string;
  // Brand logo component; when omitted the tile shows `monogram` instead.
  Icon?: IconComponent;
  monogram?: string;
  // Tailwind classes for the circular logo tile (background + icon/text color).
  tileClass: string;
};

const INTEGRATION_META: Record<IntegrationMetaKey, IntegrationMeta> = {
  github: {
    label: "GitHub",
    description: "Bring pull requests and issues from your repositories into Goat.",
    Icon: GitHubIcon,
    tileClass: "bg-[#181717] text-white",
  },
  jamie: {
    label: "Jamie",
    description: "Meeting notes land in Goat after every completed meeting.",
    monogram: "J",
    tileClass: "bg-[#5B5BD6] text-white",
  },
  gmail: {
    label: "Gmail",
    description: "Let Goat read and act on your email.",
    Icon: GmailIcon,
    tileClass: "bg-[#EA4335] text-white",
  },
  google_calendar: {
    label: "Google Calendar",
    description: "Give Goat visibility into your schedule and events.",
    Icon: GoogleCalendarIcon,
    tileClass: "bg-[#1A73E8] text-white",
  },
  google_drive: {
    label: "Google Drive",
    description: "Sync files and folders you choose into Goat.",
    Icon: GoogleDriveIcon,
    tileClass: "bg-[#1FA463] text-white",
  },
  linear: {
    label: "Linear",
    description: "Connect issues, projects, and comments from Linear.",
    Icon: LinearIcon,
    tileClass: "bg-[#5E6AD2] text-white",
  },
  slack: {
    label: "Slack",
    description: "Let Goat read channels and act as you in Slack.",
    Icon: SlackIcon,
    tileClass: "bg-[#4A154B] text-white",
  },
  hubspot: {
    label: "HubSpot",
    description: "Sync CRM activity on contacts, companies, and deals.",
    Icon: HubSpotIcon,
    tileClass: "bg-[#FF7A59] text-white",
  },
  attio: {
    label: "Attio",
    description: "Sync CRM records and notes from Attio.",
    Icon: AttioIcon,
    tileClass: "bg-[#111111] text-white",
  },
  granola: {
    label: "Granola",
    description: "Meeting notes flow in once Granola finishes each summary.",
    Icon: GranolaIcon,
    tileClass: "bg-[#F0EBE1] text-[#1A1714]",
  },
  fathom: {
    label: "Fathom",
    description: "Meeting recordings flow in after Fathom finishes each summary.",
    Icon: FathomIcon,
    tileClass: "bg-[#1355FF] text-white",
  },
  mcp: {
    label: "Goat MCP",
    description: "Use Goat from Claude, ChatGPT, or Cursor over MCP.",
    Icon: OpenCompanyMark,
    tileClass: "bg-ink text-canvas",
  },
  codex: {
    label: "Codex",
    description: "Connect your Codex subscription so Goat can run coding tasks.",
    Icon: OpenAIIcon,
    tileClass: "bg-black text-white",
  },
};

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
  return (
    <>
      <IntegrationSetupFeedback />
      {!hydrated ? (
        <IntegrationCards
          integrations={initialIntegrations}
          isWorkspaceAdmin={isWorkspaceAdmin}
          mcpSetup={mcpSetup}
        />
      ) : (
        <LiveSettingsIntegrations
          initialIntegrations={initialIntegrations}
          isWorkspaceAdmin={isWorkspaceAdmin}
          mcpSetup={mcpSetup}
        />
      )}
    </>
  );
}

function IntegrationSetupFeedback() {
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;

    const url = new URL(window.location.href);
    const status = url.searchParams.get("setup");
    if (status !== "connected" && status !== "error") return;

    handled.current = true;
    const provider = url.searchParams.get("integration");
    if (status === "error") {
      toast.error(goatIntegrationConnectionError(provider, url.searchParams.get("reason")));
    } else {
      toast.success(goatIntegrationConnectionSuccess(provider));
    }

    url.searchParams.delete("integration");
    url.searchParams.delete("setup");
    url.searchParams.delete("reason");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);

  return null;
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
    <IntegrationCards
      integrations={integrations}
      isWorkspaceAdmin={isWorkspaceAdmin}
      mcpSetup={mcpSetup}
    />
  );
}

function IntegrationCards({
  integrations,
  isWorkspaceAdmin,
  mcpSetup,
}: {
  integrations: GoatIntegrationState;
  isWorkspaceAdmin: boolean;
  mcpSetup: GoatMcpSetupView;
}) {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <SectionHeader
          title="Workspace"
          description={`Shared connections that feed the brains in this workspace.${
            isWorkspaceAdmin ? "" : " Managed by workspace admins."
          }`}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <IntegrationCardRow integration={integrations.github} canConnect={isWorkspaceAdmin} />
          <IntegrationCardRow integration={integrations.jamie} canConnect={isWorkspaceAdmin} />
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <SectionHeader
          title="Personal"
          description="Connections that act as you. Only you can manage them or wire them into brains."
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <IntegrationProviderGroupCard
            provider="gmail"
            accounts={integrations.personalAccounts.gmail}
          />
          <IntegrationProviderGroupCard
            provider="google_calendar"
            accounts={integrations.personalAccounts.google_calendar}
          />
          <IntegrationProviderGroupCard
            provider="google_drive"
            accounts={integrations.personalAccounts.google_drive}
          />
          <IntegrationCardRow integration={integrations.linear} />
          <IntegrationProviderGroupCard
            provider="slack"
            accounts={integrations.personalAccounts.slack}
          />
          <IntegrationProviderGroupCard
            provider="hubspot"
            accounts={integrations.personalAccounts.hubspot}
          />
          <IntegrationProviderGroupCard
            provider="attio"
            accounts={integrations.personalAccounts.attio}
          />
          <IntegrationProviderGroupCard
            provider="granola"
            accounts={integrations.personalAccounts.granola}
          />
          <IntegrationProviderGroupCard
            provider="fathom"
            accounts={integrations.personalAccounts.fathom}
          />
          <McpIntegrationCard setup={mcpSetup} />
          <CodexIntegrationCard integration={integrations.codex} />
        </div>
      </section>
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
        {title}
      </h2>
      <p className="text-[12px] leading-5 text-ink-subtle">{description}</p>
    </div>
  );
}

// The card shell that matches every integration: a colored brand-logo tile, the
// title + description, an optional body (connected accounts, code panels), and a
// footer action pinned to the bottom so the "Connect" pills line up across a row.
function IntegrationCard({
  meta,
  body,
  footer,
}: {
  meta: IntegrationMeta;
  body?: ReactNode;
  footer?: ReactNode;
}) {
  const Icon = meta.Icon;
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div
        className={cn(
          "flex size-12 shrink-0 items-center justify-center rounded-full",
          meta.tileClass,
        )}
      >
        {Icon ? (
          <Icon size={24} />
        ) : (
          <span className="text-[18px] font-semibold leading-none">{meta.monogram}</span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[15px] font-semibold leading-tight text-ink">{meta.label}</span>
        <p className="text-[13px] leading-5 text-ink-subtle">{meta.description}</p>
      </div>
      {body}
      {footer ? <div className="mt-auto pt-1">{footer}</div> : null}
    </div>
  );
}

// The outline pill used for navigation actions (Connect / Reconnect / Set up).
function ConnectLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="inline-flex items-center justify-center rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      {label}
    </a>
  );
}

function ConnectedStatus({ label = "Connected" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-subtle">
      <span className="size-1.5 rounded-full bg-[#22C55E]" aria-hidden="true" />
      {label}
    </span>
  );
}

function NotConnectedStatus() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-subtle">
      <span className="size-1.5 rounded-full bg-ink-subtle/40" aria-hidden="true" />
      Not connected
    </span>
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

function McpIntegrationCard({ setup }: { setup: GoatMcpSetupView }) {
  const clientLabel = setup.preferredClient ? MCP_CLIENT_LABELS[setup.preferredClient] : null;
  const connected = Boolean(setup.completedAt);
  const detail = connected
    ? clientLabel
      ? `Connected with ${clientLabel}`
      : "Connected"
    : clientLabel
      ? `Continue setup for ${clientLabel}`
      : "Claude, ChatGPT, or Cursor";

  return (
    <IntegrationCard
      meta={INTEGRATION_META.mcp}
      body={<p className="truncate text-[12px] leading-4 text-ink-subtle">{detail}</p>}
      footer={
        <Link
          href="/settings/mcp"
          className="inline-flex items-center justify-center rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          {connected ? "Manage" : "Set up"}
        </Link>
      }
    />
  );
}

// Single workspace connection (GitHub, Jamie): one status per provider. Renders
// read-only for non-admin members via `canConnect`.
function IntegrationCardRow({
  integration,
  canConnect = true,
}: {
  integration:
    | GoatGoogleProviderState
    | GoatLinearProviderState
    | GoatGitHubProviderState
    | GoatJamieProviderState
    | GoatSlackProviderState;
  canConnect?: boolean;
}) {
  const meta = INTEGRATION_META[integration.provider];
  const status = integrationStatus(integration);
  const connectHref = integrationConnectHref(integration.provider);
  const connected = status === "Connected";
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
    <IntegrationCard
      meta={meta}
      footer={
        connected ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <ConnectedStatus />
            {accountLabel ? (
              <span className="truncate text-[12px] leading-4 text-ink-subtle">
                · {accountLabel}
              </span>
            ) : null}
          </div>
        ) : canConnect ? (
          <ConnectLink href={connectHref} label={status} />
        ) : (
          <NotConnectedStatus />
        )
      }
    />
  );
}

// A personal provider with any number of connected accounts. Zero accounts
// renders the classic "Connect" card; with accounts, each connection gets its
// own row inside the card (identity + status + disconnect) plus an "Add account"
// affordance — a second OAuth pass creates a second integration row.
function IntegrationProviderGroupCard({
  provider,
  accounts,
}: {
  provider: GoatPersonalAccountProvider;
  accounts: GoatIntegrationAccountView[];
}) {
  const meta = INTEGRATION_META[provider];
  const connectHref = integrationConnectHref(provider);
  if (accounts.length === 0) {
    return (
      <IntegrationCard meta={meta} footer={<ConnectLink href={connectHref} label="Connect" />} />
    );
  }
  return (
    <IntegrationCard
      meta={meta}
      body={
        <div className="flex flex-col gap-1.5">
          {accounts.map((account) => (
            <IntegrationAccountRow key={account.integrationId} account={account} />
          ))}
        </div>
      }
      footer={<ConnectLink href={connectHref} label="Add account" />}
    />
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
      : account.provider === "linear" ||
          account.provider === "hubspot" ||
          account.provider === "attio"
        ? account.connectionLabel ||
          account.accountName ||
          account.accountEmail ||
          account.integrationId
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
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/70 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-ink-subtle">
          {identity}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
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

function CodexIntegrationCard({ integration }: { integration: GoatCodexProviderState }) {
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
    <IntegrationCard
      meta={INTEGRATION_META.codex}
      body={
        <div className="flex flex-col gap-2">
          {accountLabel ? (
            <p className="truncate text-[12px] leading-4 text-ink-subtle">{accountLabel}</p>
          ) : null}
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
      }
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={startAuth}
            disabled={isPending}
            aria-busy={isPending || isPolling}
            className="inline-flex items-center justify-center rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-60"
          >
            {buttonLabel(status, isPending)}
          </button>
          {integration.connected ? (
            <button
              type="button"
              onClick={disconnect}
              disabled={isPending}
              className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[13px] font-medium text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-60"
            >
              Disconnect
            </button>
          ) : null}
        </div>
      }
    />
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
  provider:
    | GoatGoogleProviderState["provider"]
    | "linear"
    | "github"
    | "jamie"
    | "slack"
    | "hubspot"
    | "granola"
    | "fathom"
    | "attio",
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
  if (provider === "granola") return "/settings/granola";
  if (provider === "fathom") return "/settings/fathom";
  if (provider === "attio") return "/settings/attio";
  if (provider === "slack") return "/api/integrations/slack/start?returnTo=/settings/integrations";
  if (provider === "hubspot")
    return "/api/integrations/hubspot/start?returnTo=/settings/integrations";
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
