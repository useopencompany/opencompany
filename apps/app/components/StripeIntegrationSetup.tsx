"use client";

import { Check, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { StripeProviderState } from "@/lib/integration-state";
import {
  disconnectStripeIntegrationAction,
  saveStripeRestrictedApiKeyAction,
} from "@/lib/integrations/stripe-actions";

export function StripeIntegrationSetup({
  initialState,
  canManage,
}: {
  initialState: StripeProviderState;
  canManage: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState(initialState);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const status = setupStatus(state);

  function saveApiKey() {
    setError(null);
    startTransition(async () => {
      const result = await saveStripeRestrictedApiKeyAction(apiKey);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setState(result.state);
      setApiKey("");
      router.refresh();
    });
  }

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
            Restricted API key
          </h2>
          {state.connected ? (
            <div className="mx-2 flex items-start gap-2 rounded-md border border-border bg-surface-muted px-2.5 py-2">
              <Check size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-ink" />
              <div className="min-w-0">
                <span className="block text-[13px] font-medium leading-5 text-ink">
                  Restricted key saved
                </span>
                <span className="block text-[12px] leading-4 text-ink-subtle">
                  Paste a new restricted key below to rotate it.
                </span>
              </div>
            </div>
          ) : null}
          <label className="flex flex-col gap-1 px-2">
            <span className="text-[12px] leading-4 text-ink-subtle">
              {state.connected ? "New restricted key" : "Restricted key"}
            </span>
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={state.connected ? "rk_live_… or rk_test_…" : "rk_live_…"}
              disabled={isPending}
              className="h-9 rounded-md border border-border bg-surface px-2.5 font-mono text-[13px] text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
          {error ? <p className="px-2 text-[12px] leading-4 text-warning">{error}</p> : null}
          <div className="flex flex-col items-start gap-3 px-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 text-[12px] leading-4 text-ink-subtle">
              The key is encrypted at rest and never exposed to Chat.
            </span>
            <div className="flex shrink-0 items-center gap-2">
              {state.connected ? (
                <button
                  type="button"
                  onClick={disconnect}
                  disabled={isPending}
                  className="inline-flex items-center rounded-md border border-ink/15 px-3 py-2 text-[13px] font-medium leading-none text-ink transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Disconnect
                </button>
              ) : null}
              <button
                type="button"
                onClick={saveApiKey}
                disabled={isPending || apiKey.trim().length === 0}
                className="inline-flex items-center gap-2 rounded-md bg-ink px-3 py-2 text-[13px] font-medium leading-none text-canvas transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Check size={14} strokeWidth={2} />
                {state.connected ? "Update key" : "Connect Stripe"}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Setup in Stripe
        </h2>
        <ol className="list-decimal space-y-2 pl-6 text-[13px] leading-5 text-ink-subtle">
          <li>
            Open{" "}
            <a
              href="https://dashboard.stripe.com/apikeys"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-ink underline underline-offset-2"
            >
              Stripe API keys
              <ExternalLink size={12} />
            </a>{" "}
            in the Stripe Dashboard.
          </li>
          <li>
            Create a restricted key named <strong className="font-medium text-ink">Goat</strong>.
          </li>
          <li>
            Give it read access to Balance, Subscriptions, and Invoices. Balance access includes
            balance transactions. Leave every write permission off.
          </li>
          <li>Copy the key once, paste it above, and connect.</li>
        </ol>
        <p className="px-2 text-[13px] leading-5 text-ink-subtle">
          Main chat can then answer questions about recent payment activity, cash available in
          Stripe, subscription health and estimated MRR, and open receivables. Goat rejects
          unrestricted <code>sk_</code> keys and never exposes the saved key to the model.
        </p>
      </section>
    </div>
  );
}

function setupStatus(state: StripeProviderState) {
  if (state.connected) {
    const mode = state.livemode === true ? "live" : state.livemode === false ? "test" : null;
    return {
      label: state.accountName ? `Connected to ${state.accountName}` : "Stripe is connected",
      detail: mode
        ? `Chat has read-only access to ${mode}-mode financial metrics.`
        : "Chat has read-only access to Stripe financial metrics.",
      badge: mode === "test" ? "Test mode" : "Connected",
    };
  }
  if (state.status === "needs_reauth" || state.status === "sync_failed") {
    return {
      label: "Needs a new restricted key",
      detail: state.statusReason ?? "Stripe rejected the saved key. Paste a new one below.",
      badge: "Reconnect",
    };
  }
  return {
    label: "Not connected",
    detail: "Connect a restricted, read-only Stripe key for founder metrics in Chat.",
    badge: "Setup",
  };
}

function emptyStripeState(): StripeProviderState {
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
