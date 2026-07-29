"use client";

import { Check, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { GoatStripeProviderState } from "@/lib/integration-state";
import { disconnectStripeIntegrationAction } from "@/lib/integrations/stripe-actions";

export function StripeIntegrationSetup({
  initialState,
  canManage,
}: {
  initialState: GoatStripeProviderState;
  canManage: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState(initialState);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const status = setupStatus(state);
  const connectHref = "/api/integrations/stripe/start?returnTo=/settings/stripe";

  function disconnect() {
    setError(null);
    startTransition(async () => {
      const result = await disconnectStripeIntegrationAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setState(emptyStripeState());
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-1">
        <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Status
        </h2>
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[14px] font-medium leading-tight text-ink">{status.label}</span>
            <span className="text-[12px] leading-4 text-ink-subtle">{status.detail}</span>
          </div>
          <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
            {status.badge}
          </span>
        </div>
        {!canManage ? (
          <p className="px-2 pt-1 text-[12px] leading-4 text-ink-subtle">
            Stripe is a workspace integration managed by workspace admins.
          </p>
        ) : null}
      </section>

      {canManage ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
            Stripe authorization
          </h2>
          {state.connected ? (
            <div className="mx-2 flex items-start gap-2 rounded-md border border-border bg-surface-muted px-2.5 py-2">
              <Check size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-ink" />
              <div className="min-w-0">
                <span className="block text-[13px] font-medium leading-5 text-ink">
                  Read-only access authorized
                </span>
                <span className="block text-[12px] leading-4 text-ink-subtle">
                  Stripe manages the grant. Goat stores encrypted OAuth tokens and refreshes them
                  automatically.
                </span>
              </div>
            </div>
          ) : (
            <p className="px-2 text-[13px] leading-5 text-ink-subtle">
              Stripe will ask you to select an account and approve Goat&apos;s read-only
              permissions. You must be an administrator of that Stripe account.
            </p>
          )}
          {error ? <p className="px-2 text-[12px] leading-4 text-warning">{error}</p> : null}
          <div className="flex flex-col items-start gap-3 px-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 text-[12px] leading-4 text-ink-subtle">
              OAuth credentials stay server-side and are never exposed to Chat.
            </span>
            <div className="flex shrink-0 items-center gap-2">
              {state.integrationId ? (
                <button
                  type="button"
                  onClick={disconnect}
                  disabled={isPending}
                  className="inline-flex items-center rounded-md border border-ink/15 px-3 py-2 text-[13px] font-medium leading-none text-ink transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {state.connected ? "Disconnect" : "Remove"}
                </button>
              ) : null}
              <a
                href={connectHref}
                aria-disabled={isPending}
                className="inline-flex items-center gap-2 rounded-md bg-ink px-3 py-2 text-[13px] font-medium leading-none text-canvas transition-opacity duration-150 hover:opacity-90 aria-disabled:pointer-events-none aria-disabled:opacity-50"
              >
                <ExternalLink size={14} strokeWidth={2} />
                {state.integrationId ? "Reauthorize Stripe" : "Connect Stripe"}
              </a>
            </div>
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Read-only permissions
        </h2>
        <ul className="space-y-2 px-2 text-[13px] leading-5 text-ink-subtle">
          <li>Balances and balance transactions for payment activity and cash availability.</li>
          <li>Subscriptions for status, cancellations, and estimated recurring value.</li>
          <li>Invoices for open receivables and failed collection attempts.</li>
          <li>Basic account details so Goat can show which Stripe account is connected.</li>
          <li>App lifecycle events so Goat removes stored access when you uninstall it.</li>
        </ul>
        <p className="px-2 text-[13px] leading-5 text-ink-subtle">
          Goat cannot create charges, refunds, subscriptions, or invoices. Main chat can answer
          questions about recent payment activity, cash available in Stripe, subscription health and
          estimated MRR, and open receivables.
        </p>
        <a
          href="https://dashboard.stripe.com/settings/apps"
          target="_blank"
          rel="noreferrer"
          className="mx-2 inline-flex w-fit items-center gap-1 text-[12px] font-medium text-ink underline underline-offset-2"
        >
          Manage installed apps in Stripe
          <ExternalLink size={12} />
        </a>
      </section>
    </div>
  );
}

function setupStatus(state: GoatStripeProviderState) {
  if (state.connected) {
    const mode = state.livemode === true ? "live" : state.livemode === false ? "test" : null;
    return {
      label: state.accountName ? `Connected to ${state.accountName}` : "Stripe is connected",
      detail: mode
        ? `Chat has read-only OAuth access to ${mode}-mode financial metrics.`
        : "Chat has read-only OAuth access to Stripe financial metrics.",
      badge: mode === "test" ? "Test mode" : "Connected",
    };
  }
  if (state.status === "needs_reauth" || state.status === "sync_failed") {
    return {
      label: "Stripe needs to be reauthorized",
      detail: state.statusReason ?? "Reconnect Stripe to restore read-only access.",
      badge: "Reconnect",
    };
  }
  return {
    label: "Not connected",
    detail: "Authorize read-only Stripe access for founder metrics in Chat.",
    badge: "Setup",
  };
}

function emptyStripeState(): GoatStripeProviderState {
  return {
    provider: "stripe",
    connected: false,
    status: "not_connected",
    integrationId: null,
    accountName: null,
    livemode: null,
    statusReason: null,
  };
}
