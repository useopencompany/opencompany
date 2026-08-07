import { randomUUID } from "node:crypto";
import type { ImessageProviderState } from "@opencompany/core/integration-state";
import { captureIntegrationAddedAnalytics } from "@opencompany/core/integrations/analytics";
import { getDb } from "@opencompany/db/client";
import { IMESSAGE_PROVIDER, imessageExternalIdForUser } from "@opencompany/db/imessage";
import { integrations } from "@opencompany/db/schema";
import { and, desc, eq, ne, sql } from "drizzle-orm";

export {
  hashImessagePairingCode,
  verifyImessagePairingCode,
} from "@/lib/integrations/imessage-pairing-code";

// Deliberately naive (no libphonenumber): strip common separators, require
// E.164. The pairing code sent to the number is the real validator — a typo'd
// number simply never confirms.
export function normalizeImessagePhoneE164(raw: string): string | null {
  const stripped = raw.trim().replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(stripped) ? stripped : null;
}

export async function connectImessageIntegration(input: {
  userWorkosId: string;
  phoneE164: string;
  now?: Date;
}): Promise<{ integrationId: string }> {
  const db = getDb();
  const now = input.now ?? new Date();

  const [integration] = await db
    .insert(integrations)
    .values({
      id: `gint_${randomUUID().replace(/-/g, "")}`,
      userWorkosId: input.userWorkosId,
      provider: IMESSAGE_PROVIDER,
      externalId: imessageExternalIdForUser(input.userWorkosId),
      connectionLabel: input.phoneE164,
      accountName: input.phoneE164,
      accountEmail: null,
      accountType: "imessage_phone",
      status: "connected",
      statusReason: null,
      scopes: [],
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [integrations.userWorkosId, integrations.provider, integrations.externalId],
      // The personal-uniqueness index is partial; the arbiter must match it.
      targetWhere: sql`${integrations.workspaceId} IS NULL`,
      set: {
        connectionLabel: input.phoneE164,
        accountName: input.phoneE164,
        accountType: "imessage_phone",
        status: "connected",
        statusReason: null,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: integrations.id });

  if (!integration) {
    throw new Error("Could not persist iMessage integration.");
  }

  await captureIntegrationAddedAnalytics({
    userWorkosId: input.userWorkosId,
    provider: "imessage",
  });

  return { integrationId: integration.id };
}

export async function getImessageIntegrationState(
  userWorkosId: string,
): Promise<ImessageProviderState> {
  const [row] = await getDb()
    .select({
      id: integrations.id,
      status: integrations.status,
      accountName: integrations.accountName,
      statusReason: integrations.statusReason,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.provider, IMESSAGE_PROVIDER),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);

  if (!row) {
    return {
      provider: "imessage",
      connected: false,
      status: "not_connected",
      integrationId: null,
      phoneE164: null,
      statusReason: null,
    };
  }

  return {
    provider: "imessage",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    phoneE164: row.accountName,
    statusReason: row.statusReason,
  };
}
