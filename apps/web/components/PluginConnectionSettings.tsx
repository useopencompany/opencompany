"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  disconnectIntegrationAccountAction,
  getIntegrationAccountUsageAction,
} from "@/lib/integration-account-actions";
import type { IntegrationAccountView, PersonalAccountProvider } from "@/lib/integration-state";
import { gmailMcpScopesSatisfied } from "@/lib/integrations/gmail-scopes";
import {
  integrationConnectionError,
  integrationConnectionSuccess,
} from "@/lib/onboarding-integrations";

export function PluginConnectionFeedback() {
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;

    const url = new URL(window.location.href);
    const status = url.searchParams.get("setup");
    if (status !== "connected" && status !== "error") return;

    handled.current = true;
    const provider = url.searchParams.get("integration");
    if (status === "error") {
      toast.error(integrationConnectionError(provider, url.searchParams.get("reason")));
    } else {
      toast.success(integrationConnectionSuccess(provider));
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

export function PluginAccountRow({
  account,
  reconnectHref,
  purposeLabel,
  reconnectUnavailableReason,
}: {
  account: IntegrationAccountView<PersonalAccountProvider | "posthog">;
  reconnectHref: string;
  purposeLabel?: string;
  reconnectUnavailableReason?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<{
    affectedBrainSourceCount: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const identity =
    account.provider === "slack" || account.provider === "x_account"
      ? [account.connectionLabel, account.accountName].filter(Boolean).join(" · ") ||
        account.accountEmail ||
        account.integrationId
      : account.provider === "linear" ||
          account.provider === "hubspot" ||
          account.provider === "attio" ||
          account.provider === "notion"
        ? account.connectionLabel ||
          account.accountName ||
          account.accountEmail ||
          account.integrationId
        : account.accountEmail || account.accountName || account.integrationId;
  const needsReconnect = account.status === "needs_reauth" || account.status === "sync_failed";
  const needsGmailMcpScope =
    account.provider === "gmail" && account.connected && !gmailMcpScopesSatisfied(account.scopes);

  const beginDisconnect = () => {
    setError(null);
    startTransition(async () => {
      const usage = await getIntegrationAccountUsageAction(account.integrationId);
      if (!usage.ok) {
        setError(usage.error);
        return;
      }
      if (usage.affectedBrainSourceCount > 0) {
        setConfirming({ affectedBrainSourceCount: usage.affectedBrainSourceCount });
        return;
      }
      const result = await disconnectIntegrationAccountAction(account.integrationId);
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  };

  const confirmDisconnect = () => {
    setError(null);
    startTransition(async () => {
      const result = await disconnectIntegrationAccountAction(account.integrationId);
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
          {purposeLabel ? (
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
              {purposeLabel}
            </span>
          ) : null}
          {account.connected ? (
            <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
              Connected
            </span>
          ) : reconnectUnavailableReason ? (
            <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
              Unavailable
            </span>
          ) : needsReconnect ? (
            <span className="rounded-full bg-warning-bg px-2 py-0.5 text-[11px] font-medium leading-4 text-warning">
              Needs reconnect
            </span>
          ) : (
            <a
              href={reconnectHref}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
            >
              Reconnect
            </a>
          )}
          {needsGmailMcpScope ? (
            <a
              href={reconnectHref}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
            >
              Enable full Gmail tools
            </a>
          ) : null}
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
      {needsReconnect ? (
        <div className="flex flex-col gap-1">
          {reconnectUnavailableReason || account.statusReason ? (
            <p className="text-[12px] leading-4 text-warning">
              {reconnectUnavailableReason || account.statusReason}
            </p>
          ) : null}
          {reconnectUnavailableReason ? null : (
            <a
              href={reconnectHref}
              className="w-fit rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
            >
              Reconnect
            </a>
          )}
        </div>
      ) : null}
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
