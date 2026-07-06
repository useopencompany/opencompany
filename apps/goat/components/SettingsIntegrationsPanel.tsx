"use client";

import { useLiveQuery } from "@tanstack/react-db";
import type { LucideIcon } from "lucide-react";
import { CalendarDays, Code2, GitBranch, ListTodo, Mail } from "lucide-react";
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
  type GoatLinearProviderState,
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
      <CodexIntegrationRow integration={integrations.codex} />
    </>
  );
}

function IntegrationRow({
  icon: Icon,
  label,
  integration,
}: {
  icon: LucideIcon;
  label: string;
  integration: GoatGoogleProviderState | GoatLinearProviderState | GoatGitHubProviderState;
}) {
  const status = integrationStatus(integration);
  const connectHref = integrationConnectHref(integration.provider);
  const accountLabel =
    integration.provider === "linear"
      ? integration.accountName
      : integration.provider === "github"
        ? integration.accountName
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

    const timer = window.setInterval(() => {
      startTransition(async () => {
        const result = await pollGoatCodexDeviceAuth(flow.id);
        if (result.ok) {
          setFlow(result.flow);
          if (result.flow.status === "completed") {
            setError(null);
            router.refresh();
          }
        } else {
          setError(result.error);
        }
      });
    }, 2500);

    return () => window.clearInterval(timer);
  }, [flow, router]);

  const startAuth = () => {
    setError(null);
    startTransition(async () => {
      const result = await startGoatCodexDeviceAuth();
      if (result.ok) {
        setFlow(result.flow);
      } else {
        setError(result.error);
      }
    });
  };

  const disconnect = () => {
    setError(null);
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
  integration: GoatGoogleProviderState | GoatLinearProviderState | GoatGitHubProviderState,
) {
  if (integration.status === "connected") return "Connected";
  if (integration.status === "needs_reauth" || integration.status === "sync_failed") {
    return "Reconnect";
  }
  return "Connect";
}

function integrationConnectHref(
  provider: GoatGoogleProviderState["provider"] | "linear" | "github",
) {
  if (provider === "gmail") return "/api/integrations/gmail/start?returnTo=/settings";
  if (provider === "google_calendar") {
    return "/api/integrations/google-calendar/start?returnTo=/settings";
  }
  if (provider === "github") return "/api/integrations/github/start?returnTo=/settings";
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
