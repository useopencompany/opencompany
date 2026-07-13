import {
  GOAT_PRO_MONTHLY_SEAT_PRICE_EUR_CENTS,
  loadGoatBillingOverview,
} from "@opencompany/db/goat-billing";
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
        seatSyncPending: Boolean(overview.billing.seatSyncPendingAt),
        seatCount: overview.seatCount,
        seatPriceEurCents: GOAT_PRO_MONTHLY_SEAT_PRICE_EUR_CENTS,
        monthlySubtotalEurCents: overview.monthlySubtotalEurCents,
        monthlyIngestionsUsed: overview.monthlyUsed,
        monthlyIngestionLimit: overview.plan === "free" ? overview.window.limit : null,
        monthStartedAt: overview.monthWindow.start.toISOString(),
        monthResetAt: overview.monthWindow.resetAt.toISOString(),
        isAdmin: context.role === "admin",
      }}
    />
  );
}
