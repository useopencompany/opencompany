"use client";

import { type LucideIcon as IconComponent, SlackIcon } from "@opencompany/ui/icons";
import { useLiveQuery } from "@tanstack/react-db";
import { CalendarDays, Code2, FileText, GitBranch, ListTodo, Mail } from "lucide-react";
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
  type GoatCodexProviderState,
  type GoatGitHubProviderState,
  type GoatGoogleProviderState,
  type GoatIntegrationState,
  type GoatJamieProviderState,
  type GoatLinearProviderState,
  type GoatSlackProviderState,
  goatIntegrationStateFromRows,
} from "@/lib/integration-state";
import { createGoatCollections, type GoatIntegrationRow } from "@/lib/task-collections";

export function SettingsIntegrationsPanel({
  initialIntegrations,
}: {
  initialIntegrations: GoatIntegrationState;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return <IntegrationRows integrations={initialIntegrations} />;
  return <LiveSettingsIntegrations initialIntegrations={initialIntegrations} />;
}

function LiveSettingsIntegrations({
  initialIntegrations,
}: {
  initialIntegrations: GoatIntegrationState;
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  const { data: rows, isLoading } = useLiveQuery((q) =>
    q.from({ integration: collections.integrations }),
  );
  const integrations = useMemo(() => {
    if (isLoading && !rows?.length) return initialIntegrations;
    return {
      ...goatIntegrationStateFromRows((rows ?? []) as GoatIntegrationRow[]),
      codex: initialIntegrations.codex,
    };
  }, [initialIntegrations, isLoading, rows]);

  return <IntegrationRows integrations={integrations} />;
}

function IntegrationRows({ integrations }: { integrations: GoatIntegrationState }) {
  return (
    <>
      <IntegrationRow icon={Mail} label="Gmail" integration={integrations.gmail} />
      <IntegrationRow
        icon={CalendarDays}
        label="Google Calendar"
        integration={integrations.google_calendar}
      />
      <IntegrationRow icon={ListTodo} label="Linear" integration={integrations.linear} />
      <IntegrationRow icon={GitBranch} label="GitHub" integration={integrations.github} />
      <IntegrationRow icon={FileText} label="Jamie" integration={integrations.jamie} />
      <IntegrationRow icon={SlackIcon} label="Slack" integration={integrations.slack} />
      <CodexIntegrationRow integration={integrations.codex} />
    </>
  );
}

function IntegrationRow({
  icon: Icon,
  label,
  integration,
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
        {status === "Connected" ? (
          <span className="ml-auto shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
            {status}
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
  if (provider === "gmail") return "/api/integrations/gmail/start?returnTo=/settings";
  if (provider === "google_calendar") {
    return "/api/integrations/google-calendar/start?returnTo=/settings";
  }
  if (provider === "github") return "/api/integrations/github/start?returnTo=/settings";
  if (provider === "jamie") return "/settings/jamie";
  if (provider === "slack") return "/api/integrations/slack/start?returnTo=/settings";
  return "/api/integrations/linear/start?returnTo=/settings";
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
