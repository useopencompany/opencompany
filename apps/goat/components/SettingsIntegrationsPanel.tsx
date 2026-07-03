"use client";

import { useLiveQuery } from "@tanstack/react-db";
import type { LucideIcon } from "lucide-react";
import { CalendarDays, ListTodo, Mail } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { useHydrated } from "@/components/useHydrated";
import {
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
    return goatIntegrationStateFromRows((rows ?? []) as GoatIntegrationRow[]);
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
  integration: GoatGoogleProviderState | GoatLinearProviderState;
}) {
  const status = integrationStatus(integration);
  const connectHref = integrationConnectHref(integration.provider);
  const accountLabel =
    integration.provider === "linear"
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
        <Link
          href={connectHref}
          className="ml-auto shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          {status}
        </Link>
      </div>
    </div>
  );
}

function integrationStatus(integration: GoatGoogleProviderState | GoatLinearProviderState) {
  if (integration.status === "connected") return "Connected";
  if (integration.status === "needs_reauth" || integration.status === "sync_failed") {
    return "Reconnect";
  }
  return "Connect";
}

function integrationConnectHref(provider: GoatGoogleProviderState["provider"] | "linear") {
  if (provider === "gmail") return "/api/integrations/gmail/start?returnTo=/settings";
  if (provider === "google_calendar") {
    return "/api/integrations/google-calendar/start?returnTo=/settings";
  }
  return "/api/integrations/linear/start?returnTo=/settings";
}
