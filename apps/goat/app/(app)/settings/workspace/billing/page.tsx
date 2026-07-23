import { PLATFORM_FEE_BPS } from "@opencompany/billing";
import { loadGoatBillingOverview } from "@opencompany/db/goat-billing";
import {
  GOAT_DEFAULT_TOP_UP_USD_CENTS,
  GOAT_INGEST_ITEM_FEE_USD_MICROS,
  GOAT_LOW_BALANCE_WARN_USD_MICROS,
  GOAT_MAX_TOP_UP_USD_CENTS,
  GOAT_MIN_TOP_UP_USD_CENTS,
  GOAT_TOP_UP_AMOUNTS_USD_CENTS,
} from "@opencompany/db/goat-billing-constants";
import { loadGoatCreditOverview } from "@opencompany/db/goat-credits";
import { GoatBillingPanel } from "@/components/GoatBillingPanel";
import { currentGoatUser } from "@/lib/auth";

export default async function WorkspaceBillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ topup?: string }>;
}) {
  const [context, params] = await Promise.all([currentGoatUser(), searchParams]);
  const [overview, credit] = await Promise.all([
    loadGoatBillingOverview(context.workspace.id),
    loadGoatCreditOverview(context.workspace.id),
  ]);
  return (
    <GoatBillingPanel
      data={{
        creditBalanceUsdMicros: overview.creditBalanceUsdMicros,
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
        topUpAmountsCents: [...GOAT_TOP_UP_AMOUNTS_USD_CENTS],
        defaultTopUpCents: GOAT_DEFAULT_TOP_UP_USD_CENTS,
        minTopUpCents: GOAT_MIN_TOP_UP_USD_CENTS,
        maxTopUpCents: GOAT_MAX_TOP_UP_USD_CENTS,
        autoRefill: {
          enabled: overview.autoRefill.enabled,
          amountCents: overview.autoRefill.amountCents,
          hasPaymentMethod: overview.autoRefill.hasPaymentMethod,
          lastError: overview.autoRefill.lastError,
        },
        platformFeePercent: PLATFORM_FEE_BPS / 100,
        ingestFeeUsdCentsPer50: (GOAT_INGEST_ITEM_FEE_USD_MICROS * 50) / 10_000,
        hasStripeCustomer: Boolean(overview.billing.stripeCustomerId),
        isAdmin: context.role === "admin",
      }}
      topupResult={
        params.topup === "success" ? "success" : params.topup === "cancelled" ? "cancelled" : null
      }
    />
  );
}
