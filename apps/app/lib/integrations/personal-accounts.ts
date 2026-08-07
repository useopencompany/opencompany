import {
  type IntegrationAccountView,
  type PersonalAccountProvider,
  personalAccountsFromRows,
} from "@opencompany/core/integration-state";
import { getDb } from "@opencompany/db/client";
import { integrations } from "@opencompany/db/schema";
import { and, eq, isNull } from "drizzle-orm";

// Server-side mirror of the Electric-fed client state: all of the user's
// personal (workspace_id IS NULL) integration rows, grouped per provider.
export async function getPersonalAccounts(
  userWorkosId: string,
): Promise<Record<PersonalAccountProvider, IntegrationAccountView[]>> {
  const rows = await getDb()
    .select({
      id: integrations.id,
      provider: integrations.provider,
      workspaceId: integrations.workspaceId,
      externalId: integrations.externalId,
      accountEmail: integrations.accountEmail,
      accountName: integrations.accountName,
      connectionLabel: integrations.connectionLabel,
      statusReason: integrations.statusReason,
      status: integrations.status,
      scopes: integrations.scopes,
      capabilityModes: integrations.capabilityModes,
    })
    .from(integrations)
    .where(and(eq(integrations.userWorkosId, userWorkosId), isNull(integrations.workspaceId)))
    .orderBy(integrations.createdAt);
  return personalAccountsFromRows(rows);
}
