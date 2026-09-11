import { getDb } from "@opencompany/db/client";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { MicrosoftIntegrationProvider } from "./microsoft-oauth";

export async function loadMicrosoftIntegration(input: {
  provider: MicrosoftIntegrationProvider;
  userWorkosId: string;
  db?: any;
}) {
  const [row] = await (input.db ?? getDb())
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
      scopes: integrations.scopes,
      accountEmail: integrations.accountEmail,
      accountName: integrations.accountName,
      capabilityModes: integrations.capabilityModes,
      toolModes: integrations.toolModes,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, input.userWorkosId),
        isNull(integrations.workspaceId),
        eq(integrations.provider, input.provider),
        ne(integrations.status, "disconnected"),
      ),
    )
    // Matches the settings selection in plugin-connection-state.ts: lastSyncedAt
    // moves on connect and reconnect but not on permission edits, so reconnecting
    // an older account makes it active without a mode change stealing the slot.
    .orderBy(desc(integrations.lastSyncedAt), desc(integrations.id))
    .limit(1);
  return row;
}
