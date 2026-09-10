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
    .orderBy(desc(integrations.createdAt), desc(integrations.id))
    .limit(1);
  return row;
}
