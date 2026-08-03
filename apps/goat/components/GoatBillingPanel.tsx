"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { BadgeCheck, CreditCard, Loader2, RefreshCw, Users, Wallet } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { GoatSettingsContent } from "@/components/GoatSettingsChrome";
import {
  createGoatBillingPortalAction,
  createGoatCreditTopUpAction,
  createGoatProCheckoutAction,
  setGoatAutoRefillAction,
} from "@/lib/billing/actions";

export type GoatBillingPanelData = {
  plan: "free" | "pro";
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  paymentNeedsAttention: boolean;
  proMonthlyPriceCents: number;
  memberCount: number;
  freeMaxMembers: number;
  proMaxMembers: number;
  creditBalanceUsdMicros: number;
  spendThisMonthUsdMicros: number;
  spendThisMonthByCategory: {
    chat: number;
    ingestion: number;
    capabilities: number;
  };
  recentActivity: Array<{
    id: number;
    source: string;
    amountUsdMicros: number;
    providerCostUsdMicros: number;
    platformFeeUsdMicros: number;
    capabilityAction: string | null;
    isAutoRefill: boolean;
    createdAt: string;
  }>;
  lowBalanceWarnUsdMicros: number;
  topUpAmountsCents: number[];
  defaultTopUpCents: number;
  minTopUpCents: number;
  maxTopUpCents: number;
  autoRefill: {
    enabled: boolean;
    amountCents: number;
    hasPaymentMethod: boolean;
    lastError: string | null;
  };
  platformFeePercent: number;
  ingestFeeUsdCentsPer50: number;
  hasStripeCustomer: boolean;
  isAdmin: boolean;
};

export function GoatBillingPanel({
  data,
  checkoutResult,
  topupResult,
}: {
  data: GoatBillingPanelData;
  checkoutResult: "success" | "cancelled" | null;
  topupResult: "success" | "cancelled" | null;
}) {
  const [isPending, startTransition] = useTransition();
  const [customAmount, setCustomAmount] = useState(String(data.defaultTopUpCents / 100));
  const [autoRefillEnabled, setAutoRefillEnabled] = useState(data.autoRefill.enabled);
  const [autoRefillAmount, setAutoRefillAmount] = useState(
    String(data.autoRefill.amountCents / 100),
  );
  const announcedTopupResult = useRef(false);
  const announcedCheckoutResult = useRef(false);

  useEffect(() => {
    if (!checkoutResult || announcedCheckoutResult.current) return;
    announcedCheckoutResult.current = true;
    if (checkoutResult === "success") {
      toast.success("Welcome to Pro. Your plan updates as soon as Stripe confirms it.");
    } else {
      toast("Pro checkout cancelled — no subscription was started.");
    }
  }, [checkoutResult]);

  useEffect(() => {
    if (!topupResult || announcedTopupResult.current) return;
    announcedTopupResult.current = true;
    if (topupResult === "success") {
      toast.success("Credits added. Your balance updates as soon as Stripe confirms the payment.");
    } else {
      toast("Top-up cancelled — no payment was made.");
    }
  }, [topupResult]);

  const lowBalance = data.creditBalanceUsdMicros < data.lowBalanceWarnUsdMicros;
  const hasManageableSubscription =
    data.subscriptionStatus !== null &&
    data.subscriptionStatus !== "canceled" &&
    data.subscriptionStatus !== "incomplete_expired";

  function run(action: () => Promise<{ ok: false; error: string }>) {
    startTransition(async () => {
      const result = await action();
      if (result?.ok === false) toast.error(result.error);
    });
  }

  const topUpCustom = () => {
    const dollars = Number(customAmount);
    if (!Number.isFinite(dollars)) {
      toast.error("Enter an amount in dollars.");
      return;
    }
    const cents = Math.round(dollars * 100);
    if (cents < data.minTopUpCents || cents > data.maxTopUpCents) {
      toast.error(
        `Top-ups must be between ${formatUsd(data.minTopUpCents)} and ${formatUsd(data.maxTopUpCents)}.`,
      );
      return;
    }
    run(() => createGoatCreditTopUpAction(cents));
  };

  const saveAutoRefill = (enabled: boolean) => {
    const dollars = Number(autoRefillAmount);
    const cents = Math.round(dollars * 100);
    if (!Number.isFinite(dollars) || cents < data.minTopUpCents || cents > data.maxTopUpCents) {
      toast.error(
        `Auto-refill amounts must be between ${formatUsd(data.minTopUpCents)} and ${formatUsd(data.maxTopUpCents)}.`,
      );
      return;
    }
    startTransition(async () => {
      const result = await setGoatAutoRefillAction({ enabled, amountCents: cents });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setAutoRefillEnabled(enabled);
      toast.success(enabled ? "Auto-refill is on." : "Auto-refill is off.");
    });
  };

  return (
    <GoatSettingsContent
      title="Billing"
      description="Choose a workspace plan and fund usage from one shared balance."
    >
      {data.paymentNeedsAttention ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12.5px] leading-5 text-ink">
          Your Pro payment needs attention. Update the payment method to keep team access active.
        </div>
      ) : null}

      {data.cancelAtPeriodEnd && data.currentPeriodEnd ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] leading-5 text-ink">
          Pro is cancelled and remains active until {formatDate(data.currentPeriodEnd)}.
        </div>
      ) : null}

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface-muted/40 p-4">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              {data.plan === "pro" ? <BadgeCheck size={13} /> : <Users size={13} />}
              {data.plan === "pro" ? "Pro plan" : "Free plan"}
            </div>
            <div className="mt-1 text-[20px] font-semibold tracking-tight text-ink">
              {data.plan === "pro" ? formatUsd(data.proMonthlyPriceCents) : "$0"}
              <span className="ml-1 text-[12.5px] font-normal text-ink-subtle">per month</span>
            </div>
            <p className="mt-1 max-w-xl text-[12.5px] leading-5 text-ink-subtle">
              {data.plan === "pro"
                ? `One workspace for up to ${data.proMaxMembers} people. Usage is billed separately from the shared credit balance.`
                : `Built for one founder. Upgrade when you are ready to share the workspace with up to ${data.proMaxMembers} people.`}
            </p>
            <p className="mt-2 text-[11.5px] text-ink-subtle">
              {data.memberCount} of {data.plan === "pro" ? data.proMaxMembers : data.freeMaxMembers}{" "}
              member
              {(data.plan === "pro" ? data.proMaxMembers : data.freeMaxMembers) === 1 ? "" : "s"}
              {" used"}
            </p>
          </div>
          {data.isAdmin ? (
            data.plan === "pro" || hasManageableSubscription ? (
              <button
                type="button"
                disabled={isPending}
                onClick={() => run(createGoatBillingPortalAction)}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-border bg-canvas px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-surface-muted disabled:opacity-50"
              >
                {isPending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <CreditCard size={13} />
                )}
                {data.plan === "pro" ? "Manage plan" : "Manage subscription"}
              </button>
            ) : (
              <button
                type="button"
                disabled={isPending}
                onClick={() => run(createGoatProCheckoutAction)}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-50"
              >
                {isPending ? <Loader2 size={13} className="animate-spin" /> : null}
                Upgrade to Pro
              </button>
            )
          ) : (
            <span className="text-[11.5px] text-ink-subtle">
              Ask a workspace admin to change plans.
            </span>
          )}
        </div>
      </section>
      {lowBalance ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] leading-5 text-ink">
          {data.creditBalanceUsdMicros <= 0
            ? "Your workspace is out of credits. Chat, ingestion, and paid capabilities are paused until you top up."
            : "Your balance is running low. Top up to keep chat, ingestion, and paid capabilities running."}
        </div>
      ) : null}

      {data.autoRefill.lastError ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12.5px] leading-5 text-ink">
          Auto-refill failed: {data.autoRefill.lastError} Update your card with a new top-up, then
          re-enable auto-refill.
        </div>
      ) : null}

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface-muted/40 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              <Wallet size={13} />
              Balance
            </div>
            <div className="mt-1 text-[24px] font-semibold tracking-tight text-ink">
              {formatUsdMicros(data.creditBalanceUsdMicros)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              Spent this month
            </div>
            <div className="mt-1 text-[17px] font-semibold tracking-tight text-ink">
              {formatUsdMicros(data.spendThisMonthUsdMicros)}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {data.topUpAmountsCents.map((amountCents) => (
            <button
              key={amountCents}
              type="button"
              disabled={isPending}
              onClick={() => run(() => createGoatCreditTopUpAction(amountCents))}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-surface-muted disabled:opacity-50 ${
                amountCents === data.defaultTopUpCents
                  ? "border-ink/30 bg-canvas"
                  : "border-border bg-canvas"
              }`}
            >
              {isPending ? <Loader2 size={12} className="animate-spin" /> : null}
              Add {formatUsd(amountCents)}
            </button>
          ))}
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] text-ink-subtle">$</span>
            <input
              inputMode="decimal"
              value={customAmount}
              onChange={(event) => setCustomAmount(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") topUpCustom();
              }}
              aria-label="Custom top-up amount in dollars"
              className="w-16 rounded-md border border-ink/10 bg-canvas px-2 py-1.5 text-[13px] text-ink outline-none focus:border-ink/25"
            />
            <button
              type="button"
              disabled={isPending}
              onClick={topUpCustom}
              className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
        <p className="text-[11.5px] leading-4 text-ink-subtle">
          Anyone in the workspace can add credits. Payments run through Stripe; the card is saved
          for auto-refill.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          This month
        </h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {[
            ["Chat", data.spendThisMonthByCategory.chat],
            ["Brain ingestion", data.spendThisMonthByCategory.ingestion],
            ["Paid capabilities", data.spendThisMonthByCategory.capabilities],
          ].map(([label, amount]) => (
            <div key={String(label)} className="rounded-lg border border-border px-3 py-2.5">
              <div className="text-[11px] text-ink-subtle">{label}</div>
              <div className="mt-0.5 text-[15px] font-semibold text-ink">
                {formatUsdMicros(Number(amount))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface-muted/40 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              <RefreshCw size={13} />
              Auto-refill
            </div>
            <p className="mt-1 text-[12.5px] leading-5 text-ink-subtle">
              Automatically add credits with your saved card when the balance drops below $5.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoRefillEnabled}
            disabled={isPending || (!autoRefillEnabled && !data.autoRefill.hasPaymentMethod)}
            onClick={() => saveAutoRefill(!autoRefillEnabled)}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
              autoRefillEnabled ? "bg-ink" : "bg-ink/20"
            }`}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full bg-canvas transition-transform ${
                autoRefillEnabled ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[12.5px] text-ink-subtle">Refill amount</span>
          <span className="text-[13px] text-ink-subtle">$</span>
          <input
            inputMode="decimal"
            value={autoRefillAmount}
            onChange={(event) => setAutoRefillAmount(event.target.value)}
            onBlur={() => {
              if (autoRefillEnabled) saveAutoRefill(true);
            }}
            aria-label="Auto-refill amount in dollars"
            className="w-16 rounded-md border border-ink/10 bg-canvas px-2 py-1.5 text-[13px] text-ink outline-none focus:border-ink/25"
          />
        </div>
        {!data.autoRefill.hasPaymentMethod ? (
          <p className="text-[11.5px] leading-4 text-ink-subtle">
            Add credits once first — auto-refill charges the card saved during a top-up.
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface-muted/40 p-4">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          How pricing works
        </h2>
        <ul className="flex flex-col gap-1 text-[12.5px] leading-5 text-ink-subtle">
          <li>
            Chat: model cost + {data.platformFeePercent}% platform fee, charged per message from
            your balance.
          </li>
          <li>
            Brain ingestion: model cost + {data.platformFeePercent}% platform fee, plus{" "}
            {formatUsd(data.ingestFeeUsdCentsPer50)} per 50 ingested items.
          </li>
          <li>
            Paid capabilities: underlying provider cost + {data.platformFeePercent}% platform fee.
            Higher-cost actions ask for one-time approval before running.
          </li>
          <li>Brain retrieval and browsing are free.</li>
        </ul>
      </section>

      {data.recentActivity.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
            Recent activity
          </h2>
          <div className="overflow-hidden rounded-lg border border-border">
            {data.recentActivity.map((entry, index) => (
              <div
                key={entry.id}
                className={`flex items-center justify-between gap-4 px-3 py-2.5 ${
                  index > 0 ? "border-t border-border" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate text-[12.5px] font-medium text-ink">
                    {billingActivityLabel(entry.source, entry.capabilityAction, entry.isAutoRefill)}
                  </div>
                  <div className="text-[11px] text-ink-subtle">
                    {new Intl.DateTimeFormat(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    }).format(new Date(entry.createdAt))}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[12.5px] font-medium text-ink">
                    {entry.amountUsdMicros < 0 ? "-" : "+"}
                    {formatUsdMicros(Math.abs(entry.amountUsdMicros))}
                  </div>
                  {entry.amountUsdMicros < 0 ? (
                    <div className="text-[10.5px] text-ink-subtle">
                      {formatUsdMicros(entry.providerCostUsdMicros)} cost +{" "}
                      {formatUsdMicros(entry.platformFeeUsdMicros)} fee
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {data.isAdmin && data.hasStripeCustomer && data.plan !== "pro" ? (
        <button
          type="button"
          disabled={isPending}
          onClick={() => run(createGoatBillingPortalAction)}
          className="inline-flex w-fit items-center gap-2 rounded-md border border-border bg-canvas px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-surface-muted disabled:opacity-50"
        >
          {isPending ? <Loader2 size={13} className="animate-spin" /> : <CreditCard size={13} />}
          Manage billing details
        </button>
      ) : null}
    </GoatSettingsContent>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(value));
}

function formatUsd(cents: number) {
  const wholeDollars = cents % 100 === 0;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: wholeDollars ? 0 : 2,
    maximumFractionDigits: wholeDollars ? 0 : 2,
  }).format(cents / 100);
}

function formatUsdMicros(usdMicros: number) {
  const dollars = usdMicros / 1_000_000;
  const fractionDigits = Math.abs(dollars) > 0 && Math.abs(dollars) < 0.1 ? 4 : 2;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(dollars);
}

function billingActivityLabel(
  source: string,
  capabilityAction: string | null,
  isAutoRefill: boolean,
) {
  if (source === "chat_model_usage") return "Chat";
  if (
    source === "ingest_model_usage" ||
    source === "ingest_fee" ||
    source === "frontier_ingest" ||
    source === "ingest_overage"
  ) {
    return "Brain ingestion";
  }
  if (source === "capability_usage") {
    return capabilityAction ? `Paid capability · ${capabilityAction}` : "Paid capability";
  }
  if (source === "stripe_topup") {
    return isAutoRefill ? "Auto-refill" : "Credit top-up";
  }
  if (source === "starter_grant") return "Starter credits";
  return "Workspace credits";
}
