import type { IntegrationAccountDto } from "@opencompany/protocol";
import {
  type GoatIntegrationAccountView,
  type GoatPersonalAccountProvider,
  goatPersonalAccountsFromRows,
} from "@/lib/integration-state";
import { serverApiClient, serverApiError } from "@/lib/server-api-client";

// Server-side snapshot for initial hydration. Live updates arrive from the API-owned
// integration account read model after the client mounts.
export async function getGoatPersonalAccounts(): Promise<
  Record<GoatPersonalAccountProvider, GoatIntegrationAccountView[]>
> {
  const response = await (await serverApiClient()).v1["integration-accounts"].$get();
  if (!response.ok) throw await serverApiError(response, "Could not load integration accounts.");
  const accounts = (await response.json()).data as IntegrationAccountDto[];
  return goatPersonalAccountsFromRows(
    accounts.map((account: IntegrationAccountDto) => ({
      ...account,
      id: account.integrationId,
      workspaceId: null,
      externalId: null,
    })),
  );
}
