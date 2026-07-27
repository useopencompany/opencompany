import { getDb } from "@opencompany/db/client";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  type GoatIntegrationAccountView,
  type GoatPersonalAccountProvider,
  goatPersonalAccountsFromRows,
} from "@/lib/integration-state";

// Server-side mirror of the Electric-fed client state: all of the user's
// personal (workspace_id IS NULL) integration rows, grouped per provider.
export async function getGoatPersonalAccounts(
  userWorkosId: string,
): Promise<Record<GoatPersonalAccountProvider, GoatIntegrationAccountView[]>> {
  const rows = await getDb()
    .select({
      id: goatIntegrations.id,
      provider: goatIntegrations.provider,
      workspaceId: goatIntegrations.workspaceId,
      externalId: goatIntegrations.externalId,
      accountEmail: goatIntegrations.accountEmail,
      accountName: goatIntegrations.accountName,
      connectionLabel: goatIntegrations.connectionLabel,
      statusReason: goatIntegrations.statusReason,
      status: goatIntegrations.status,
      scopes: goatIntegrations.scopes,
      capabilityModes: goatIntegrations.capabilityModes,
    })
    .from(goatIntegrations)
    .where(
      and(eq(goatIntegrations.userWorkosId, userWorkosId), isNull(goatIntegrations.workspaceId)),
    )
    .orderBy(goatIntegrations.createdAt);
  return goatPersonalAccountsFromRows(rows);
}
