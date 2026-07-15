import {
  GOAT_FREE_MAX_MEMBERS,
  GOAT_FREE_MONTHLY_INGESTION_LIMIT,
  GOAT_PRO_MAX_MEMBERS,
  GOAT_PRO_MONTHLY_INGESTIONS_PER_SEAT,
  GOAT_PRO_SEAT_MONTHLY_PRICE_USD_CENTS,
  loadGoatBillingOverview,
} from "@opencompany/db/goat-billing";
import {
  GOAT_INGESTION_OVERAGE_USD_CENTS_PER_100_EVENTS,
  GOAT_TOP_UP_AMOUNTS_USD_CENTS,
} from "@opencompany/db/goat-billing-constants";
import { GoatBillingPanel } from "@/components/GoatBillingPanel";
import { currentGoatUser } from "@/lib/auth";

export default async function WorkspaceBillingSettingsPage() {
  const context = await currentGoatUser();
  const overview = await loadGoatBillingOverview(context.workspace.id);
  return (
    <GoatBillingPanel
      data={{
        plan: overview.plan,
        subscriptionStatus: overview.billing.subscriptionStatus,
        cancelAtPeriodEnd: overview.billing.cancelAtPeriodEnd,
        currentPeriodEnd: overview.billing.currentPeriodEnd?.toISOString() ?? null,
        paymentNeedsAttention: overview.billing.paymentNeedsAttention,
        seatMonthlyPriceUsdCents: GOAT_PRO_SEAT_MONTHLY_PRICE_USD_CENTS,
        seatQuantity: overview.seatQuantity,
        memberCount: overview.memberCount,
        freeMaxMembers: GOAT_FREE_MAX_MEMBERS,
        proMaxMembers: GOAT_PRO_MAX_MEMBERS,
        monthlyIngestionsUsed: overview.used,
        monthlyIngestionLimit: overview.window.limit,
        freeMonthlyLimit: GOAT_FREE_MONTHLY_INGESTION_LIMIT,
        proMonthlyPerSeat: GOAT_PRO_MONTHLY_INGESTIONS_PER_SEAT,
        overageUnits: overview.overageUnitsThisWindow,
        overageUsdMicros: overview.overageUsdMicrosThisWindow,
        overageCentsPer100: GOAT_INGESTION_OVERAGE_USD_CENTS_PER_100_EVENTS,
        creditBalanceUsdMicros: overview.creditBalanceUsdMicros,
        topUpAmountsCents: [...GOAT_TOP_UP_AMOUNTS_USD_CENTS],
        monthStartedAt: overview.window.start.toISOString(),
        monthResetAt: overview.window.resetAt.toISOString(),
        isAdmin: context.role === "admin",
      }}
    />
  );
}
