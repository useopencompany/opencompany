"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { disconnectIntegrationAccountAction } from "@/lib/integration-account-actions";
import type { IntegrationAccountView, PersonalAccountProvider } from "@/lib/integration-state";
import { gmailMcpScopesSatisfied } from "@/lib/integrations/gmail-scopes";
import { hasGoogleSheetsWriteScope } from "@/lib/integrations/google-drive-scopes";
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
  // Connected before the Sheets tools shipped: every other Drive tool still works, so offer the
  // upgrade instead of taking the account offline.
  const needsDriveSheetsScope =
    account.provider === "google_drive" &&
    account.connected &&
    !hasGoogleSheetsWriteScope(account.scopes);

  const beginDisconnect = () => {
    setError(null);
    startTransition(async () => {
      const result = await disconnectIntegrationAccountAction(account.integrationId);
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-3 py-2">
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
          {needsDriveSheetsScope ? (
            <a
              href={reconnectHref}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
            >
              Enable Sheets tools
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
      {error ? <div className="text-[12px] leading-4 text-warning">{error}</div> : null}
    </div>
  );
}
