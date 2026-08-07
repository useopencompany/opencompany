import { loadGoatBillingOverview } from "@opencompany/db/billing";
import {
  GOAT_AUTO_REFILL_MONTHLY_MAX_USD_CENTS,
  GOAT_DEFAULT_TOP_UP_USD_CENTS,
  GOAT_HOBBY_INCLUDED_USAGE_USD_CENTS,
  GOAT_INCLUDED_USAGE_PER_SEAT_USD_CENTS,
  GOAT_LOW_BALANCE_WARN_USD_MICROS,
  GOAT_MAX_TOP_UP_USD_CENTS,
  GOAT_MIN_TOP_UP_USD_CENTS,
  GOAT_PRO_MONTHLY_PRICE_USD_CENTS,
  GOAT_TOP_UP_AMOUNTS_USD_CENTS,
  goatWorkspaceMemberCap,
} from "@opencompany/db/billing-constants";
import { loadGoatCreditOverview } from "@opencompany/db/credits";
import { GoatBillingPanel } from "@/components/GoatBillingPanel";
import { currentGoatUser } from "@/lib/auth";

export default async function WorkspaceBillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; topup?: string }>;
}) {
  const [context, params] = await Promise.all([currentGoatUser(), searchParams]);
  const overview = await loadGoatBillingOverview(context.workspace.id);
  const credit = await loadGoatCreditOverview(context.workspace.id);
  return (
    <GoatBillingPanel
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
        proMonthlyPriceCents: GOAT_PRO_MONTHLY_PRICE_USD_CENTS,
        hobbyIncludedUsageCents: GOAT_HOBBY_INCLUDED_USAGE_USD_CENTS,
        memberCount: overview.memberCount,
        memberCap: goatWorkspaceMemberCap(overview.billing.plan),
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
        lowBalanceWarnUsdMicros: GOAT_LOW_BALANCE_WARN_USD_MICROS,
        includedUsagePerSeatCents: GOAT_INCLUDED_USAGE_PER_SEAT_USD_CENTS,
        topUpAmountsCents: [...GOAT_TOP_UP_AMOUNTS_USD_CENTS],
        defaultTopUpCents: GOAT_DEFAULT_TOP_UP_USD_CENTS,
        minTopUpCents: GOAT_MIN_TOP_UP_USD_CENTS,
        maxTopUpCents: GOAT_MAX_TOP_UP_USD_CENTS,
        autoRefillMonthlyMaxCents: GOAT_AUTO_REFILL_MONTHLY_MAX_USD_CENTS,
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
