"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { CalendarDays, Check, CreditCard, DatabaseZap, Loader2 } from "lucide-react";
import { type ReactNode, useTransition } from "react";
import { GoatSettingsContent } from "@/components/GoatSettingsChrome";
import { createGoatBillingPortalAction, createGoatProCheckoutAction } from "@/lib/billing/actions";

export type GoatBillingPanelData = {
  plan: "free" | "pro";
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  paymentNeedsAttention: boolean;
  monthlyPriceUsdCents: number;
  monthlyIngestionsUsed: number;
  monthlyIngestionLimit: number;
  freeMonthlyLimit: number;
  proMonthlyLimit: number;
  sourceBonus: number;
  sourceBonusPerSource: number;
  sourceBonusMax: number;
  monthStartedAt: string;
  monthResetAt: string;
  isAdmin: boolean;
};

export function GoatBillingPanel({ data }: { data: GoatBillingPanelData }) {
  const [isPending, startTransition] = useTransition();
  const isPro = data.plan === "pro";
  const isActivating =
    data.subscriptionStatus === "incomplete" || data.subscriptionStatus === "trialing";
  const hasManagedSubscription =
    Boolean(data.subscriptionStatus) &&
    data.subscriptionStatus !== "canceled" &&
    data.subscriptionStatus !== "incomplete_expired";
  const formattedMonthlyPrice = formatUsd(data.monthlyPriceUsdCents);
  const baseMonthlyLimit = isPro ? data.proMonthlyLimit : data.freeMonthlyLimit;
  const bonusFeature = `+${data.sourceBonusPerSource} items/month per connected source (up to +${data.sourceBonusMax})`;

  function run(action: () => Promise<{ ok: false; error: string }>) {
    startTransition(async () => {
      const result = await action();
      if (result?.ok === false) toast.error(result.error);
    });
  }

  return (
    <GoatSettingsContent
      title="Billing"
      description="Choose a workspace plan and manage subscription billing."
    >
      {data.paymentNeedsAttention ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] leading-5 text-ink">
          Stripe could not collect the latest payment. OpenCompany Pro remains active during payment
          retries; a workspace admin should update the payment method.
        </div>
      ) : null}

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface-muted/40 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              Current plan
            </div>
            <div className="mt-1 text-[20px] font-semibold tracking-tight text-ink">
              {isPro ? "OpenCompany Pro" : isActivating ? "Activating Pro" : "Free"}
            </div>
          </div>
          <span className="rounded-full bg-canvas px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
            {data.subscriptionStatus ?? "Active"}
          </span>
        </div>
        {isPro ? (
          <div className="text-[12.5px] leading-5 text-ink-subtle">
            <span className="font-medium text-ink">{formattedMonthlyPrice}/month</span> flat, plus
            applicable tax. Unlimited members.
            {data.cancelAtPeriodEnd && data.currentPeriodEnd
              ? ` Pro remains active until ${formatDate(data.currentPeriodEnd)}.`
              : null}
          </div>
        ) : isActivating ? (
          <div className="text-[12.5px] leading-5 text-ink-subtle">
            Stripe is waiting for Checkout or the first payment to complete. No Pro entitlement is
            granted until the subscription becomes active.
          </div>
        ) : (
          <div className="text-[12.5px] leading-5 text-ink-subtle">
            Unlimited workspace members and {baseMonthlyLimit.toLocaleString()} ingested items each
            month. Every connected source adds +{data.sourceBonusPerSource} items/month, up to +
            {data.sourceBonusMax}.
          </div>
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          <BillingMetric
            icon={<DatabaseZap size={14} />}
            label={`Ingestions in ${formatMonth(data.monthStartedAt)}`}
            value={`${data.monthlyIngestionsUsed.toLocaleString()} ingestion${data.monthlyIngestionsUsed === 1 ? "" : "s"}`}
            detail={`${data.monthlyIngestionsUsed.toLocaleString()} of ${data.monthlyIngestionLimit.toLocaleString()} monthly allowance${
              data.sourceBonus > 0
                ? ` (${baseMonthlyLimit.toLocaleString()} base + ${data.sourceBonus} source bonus)`
                : ""
            }`}
            progress={Math.min(
              100,
              (data.monthlyIngestionsUsed / data.monthlyIngestionLimit) * 100,
            )}
          />
          <BillingMetric
            icon={<CalendarDays size={14} />}
            label={
              isPro
                ? data.cancelAtPeriodEnd
                  ? "Plan ends"
                  : "Next billing cycle"
                : "Allowance resets"
            }
            value={
              isPro && data.currentPeriodEnd
                ? formatDate(data.currentPeriodEnd)
                : !isPro
                  ? formatDate(data.monthResetAt)
                  : "Pending activation"
            }
            detail={
              isPro
                ? data.cancelAtPeriodEnd
                  ? "Your workspace returns to Free on this date"
                  : "Your monthly subscription renews on this date"
                : "Your Free monthly allowance starts over"
            }
          />
        </div>

        {data.isAdmin ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() =>
              run(
                hasManagedSubscription
                  ? createGoatBillingPortalAction
                  : createGoatProCheckoutAction,
              )
            }
            className="inline-flex w-fit items-center gap-2 rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-50"
          >
            {isPending ? <Loader2 size={13} className="animate-spin" /> : <CreditCard size={13} />}
            {hasManagedSubscription ? "Manage billing" : "Upgrade to Pro"}
          </button>
        ) : (
          <p className="text-[11.5px] leading-4 text-ink-subtle">
            Only workspace admins can change the plan or payment details.
          </p>
        )}
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <PlanCard
          title="Free"
          price="$0"
          active={!isPro && !isActivating}
          features={[
            `${data.freeMonthlyLimit.toLocaleString()} ingested items each month`,
            bonusFeature,
            "Unlimited workspace members",
          ]}
        />
        <PlanCard
          title="OpenCompany Pro"
          price={`${formattedMonthlyPrice}/month`}
          active={isPro}
          features={[
            `${data.proMonthlyLimit.toLocaleString()} ingested items each month`,
            bonusFeature,
            "Unlimited workspace members",
            "Plus applicable tax",
          ]}
        />
      </section>
    </GoatSettingsContent>
  );
}

function BillingMetric({
  icon,
  label,
  value,
  detail,
  progress,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  progress?: number | null;
}) {
  return (
    <div className="rounded-lg border border-border bg-canvas p-3">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
        <span className="flex size-6 items-center justify-center rounded-md bg-surface-muted text-ink">
          {icon}
        </span>
        {label}
      </div>
      <div className="mt-2 text-[17px] font-semibold tracking-tight text-ink">{value}</div>
      <div className="mt-0.5 text-[11.5px] leading-4 text-ink-subtle">{detail}</div>
      {progress != null ? (
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-muted"
          role="progressbar"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full rounded-full bg-ink" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function PlanCard({
  title,
  price,
  active,
  features,
}: {
  title: string;
  price: string;
  active: boolean;
  features: string[];
}) {
  return (
    <div className={`rounded-xl border p-4 ${active ? "border-ink/25" : "border-border"}`}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
        {active ? <span className="text-[11px] font-medium text-ink-subtle">Current</span> : null}
      </div>
      <div className="mt-1 text-[13px] text-ink-subtle">{price}</div>
      <ul className="mt-3 flex flex-col gap-1.5">
        {features.map((feature) => (
          <li key={feature} className="flex items-center gap-2 text-[12px] text-ink-subtle">
            <Check size={12} className="text-ink" />
            {feature}
          </li>
        ))}
      </ul>
    </div>
  );
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

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function formatMonth(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "long", timeZone: "UTC" }).format(
    new Date(value),
  );
}
