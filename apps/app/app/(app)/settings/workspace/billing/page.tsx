import { loadBillingOverview } from "@opencompany/db/billing";
import {
  AUTO_REFILL_MONTHLY_MAX_USD_CENTS,
  DEFAULT_TOP_UP_USD_CENTS,
  HOBBY_INCLUDED_USAGE_USD_CENTS,
  INCLUDED_USAGE_PER_SEAT_USD_CENTS,
  LOW_BALANCE_WARN_USD_MICROS,
  MAX_TOP_UP_USD_CENTS,
  MIN_TOP_UP_USD_CENTS,
  PRO_MONTHLY_PRICE_USD_CENTS,
  TOP_UP_AMOUNTS_USD_CENTS,
  workspaceMemberCap,
} from "@opencompany/db/billing-constants";
import { loadCreditOverview } from "@opencompany/db/credits";
import { BillingPanel } from "@/components/BillingPanel";
import { currentUser } from "@/lib/auth";

export default async function WorkspaceBillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; topup?: string }>;
}) {
  const [context, params] = await Promise.all([currentUser(), searchParams]);
  const overview = await loadBillingOverview(context.workspace.id);
  const credit = await loadCreditOverview(context.workspace.id);
  return (
    <BillingPanel
      data={{
        creditBalanceUsdMicros: overview.creditBalanceUsdMicros,
        includedBalanceUsdMicros: overview.includedBalanceUsdMicros,
        topUpBalanceUsdMicros: overview.topUpBalanceUsdMicros,
        plan: overview.billing.plan,
        subscriptionStatus: overview.billing.subscriptionStatus,
        seatQuantity: overview.billing.seatQuantity,
        includedUsagePeriodEnd: overview.billing.includedUsagePeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: overview.billing.cancelAtPeriodEnd,
        currentPeriodEnd: overview.billing.currentPeriodEnd?.toISOString() ?? null,
        paymentNeedsAttention: overview.billing.paymentNeedsAttention,
        proMonthlyPriceCents: PRO_MONTHLY_PRICE_USD_CENTS,
        hobbyIncludedUsageCents: HOBBY_INCLUDED_USAGE_USD_CENTS,
        memberCount: overview.memberCount,
        memberCap: workspaceMemberCap(overview.billing.plan),
        spendThisMonthUsdMicros: credit.spendThisMonthUsdMicros,
        spendThisMonthByCategory: credit.spendThisMonthByCategory,
        recentActivity: credit.recentEntries.map((entry) => ({
          id: entry.id,
          source: entry.source,
          amountUsdMicros: entry.amountUsdMicros,
          providerCostUsdMicros: entry.providerCostUsdMicros,
          platformFeeUsdMicros: entry.platformFeeUsdMicros,
          capabilityAction:
            typeof entry.metadata.capabilityAction === "string"
              ? entry.metadata.capabilityAction
              : null,
          isAutoRefill: entry.metadata.kind === "auto_refill",
          createdAt: entry.createdAt.toISOString(),
        })),
        lowBalanceWarnUsdMicros: LOW_BALANCE_WARN_USD_MICROS,
        includedUsagePerSeatCents: INCLUDED_USAGE_PER_SEAT_USD_CENTS,
        topUpAmountsCents: [...TOP_UP_AMOUNTS_USD_CENTS],
        defaultTopUpCents: DEFAULT_TOP_UP_USD_CENTS,
        minTopUpCents: MIN_TOP_UP_USD_CENTS,
        maxTopUpCents: MAX_TOP_UP_USD_CENTS,
        autoRefillMonthlyMaxCents: AUTO_REFILL_MONTHLY_MAX_USD_CENTS,
        autoRefill: {
          enabled: overview.autoRefill.enabled,
          amountCents: overview.autoRefill.amountCents,
          hasPaymentMethod: overview.autoRefill.hasPaymentMethod,
          lastError: overview.autoRefill.lastError,
        },
        isAdmin: context.role === "admin",
      }}
      topupResult={
        params.topup === "success" ? "success" : params.topup === "cancelled" ? "cancelled" : null
      }
      checkoutResult={
        params.checkout === "success"
          ? "success"
          : params.checkout === "cancelled"
            ? "cancelled"
            : null
      }
    />
  );
}
