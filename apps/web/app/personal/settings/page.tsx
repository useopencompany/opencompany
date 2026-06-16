import PersonalSettingsView from "@/components/personal/PersonalSettingsView";
import { currentWorkspace } from "@/lib/auth";
import { loadBillingOverview } from "@/lib/billing/service";
import { getAppUrl } from "@/lib/billing/stripe";
import { listPersonalMcpTokens } from "@/lib/personal/mcp-tokens";

// Lightweight personal settings (Pro mode, appearance, account, billing). Pro mode/appearance/account
// read shared client state from the /personal layout context; billing is workspace-scoped, so it is
// loaded here and passed down. The personal surface shares the user's workspace credit balance.
export default async function PersonalSettingsPage() {
  const { workspace, user } = await currentWorkspace();
  const [billing, mcpTokens] = await Promise.all([
    loadBillingOverview(workspace.id),
    listPersonalMcpTokens({ workspaceId: workspace.id, userId: user.id }),
  ]);

  return (
    <div className="h-full overflow-y-auto">
      <PersonalSettingsView
        mcp={{
          endpointUrl: `${getAppUrl()}/api/mcp/opencompany`,
          tokens: mcpTokens,
        }}
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
