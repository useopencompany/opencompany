import PersonalSettingsView from "@/components/personal/PersonalSettingsView";
import { currentWorkspace } from "@/lib/auth";
import { verifyCreditCheckoutSessionReturn } from "@/lib/billing/checkout-return";
import { loadBillingOverview } from "@/lib/billing/service";

// Lightweight personal settings (Pro mode, appearance, account, billing). Pro mode/appearance/account
// read shared client state from the /personal layout context; billing is workspace-scoped, so it is
// loaded here and passed down. The personal surface shares the user's workspace credit balance.
type PersonalSettingsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function readSearchParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
) {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

async function verifyBillingReturn(searchParams: PersonalSettingsPageProps["searchParams"]) {
  const params = searchParams ? await searchParams : {};
  if (readSearchParam(params, "billing") !== "success") return;

  const stripeCheckoutSessionId = readSearchParam(params, "stripe_checkout_session_id");
  if (stripeCheckoutSessionId) {
    await verifyCreditCheckoutSessionReturn(stripeCheckoutSessionId);
  }
}

export default async function PersonalSettingsPage({ searchParams }: PersonalSettingsPageProps) {
  await verifyBillingReturn(searchParams);

  const { workspace } = await currentWorkspace();
  const billing = await loadBillingOverview(workspace.id);

  return (
    <div className="h-full overflow-y-auto">
      <PersonalSettingsView
        billing={{
          balanceUsdMicros: billing.balanceUsdMicros,
          spendLast7UsdMicros: billing.spendLast7UsdMicros,
          spendLast30UsdMicros: billing.spendLast30UsdMicros,
          recentSessionCharges: billing.recentSessionCharges.map((entry) => ({
            ...entry,
            createdAt: entry.createdAt.toISOString(),
          })),
          ledger: billing.ledger.map((entry) => ({
            ...entry,
            createdAt: entry.createdAt.toISOString(),
          })),
        }}
      />
    </div>
  );
}
