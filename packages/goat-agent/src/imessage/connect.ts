import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  GOAT_IMESSAGE_PROVIDER,
  goatImessageExternalIdForUser,
} from "@opencompany/db/goat-imessage";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { GoatImessageProviderState } from "../integration-state";
import { captureGoatIntegrationAddedAnalytics } from "../integrations/analytics";

export {
  hashGoatImessagePairingCode,
  verifyGoatImessagePairingCode,
} from "./pairing-code";

// Follows the repo-wide injectable-db convention so the canonical API can pass
// its pooled handle while web/runner callers keep the getDb() default.
type DbLike = any;

// Deliberately naive (no libphonenumber): strip common separators, require
// E.164. The pairing code sent to the number is the real validator — a typo'd
// number simply never confirms.
export function normalizeImessagePhoneE164(raw: string): string | null {
  const stripped = raw.trim().replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(stripped) ? stripped : null;
}

export async function connectGoatImessageIntegration(input: {
  userWorkosId: string;
  phoneE164: string;
  now?: Date;
  db?: DbLike;
}): Promise<{ integrationId: string }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();

  const [integration] = await db
    .insert(goatIntegrations)
    .values({
      id: `gint_${randomUUID().replace(/-/g, "")}`,
      userWorkosId: input.userWorkosId,
      provider: GOAT_IMESSAGE_PROVIDER,
      externalId: goatImessageExternalIdForUser(input.userWorkosId),
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
      target: [
        goatIntegrations.userWorkosId,
        goatIntegrations.provider,
        goatIntegrations.externalId,
      ],
      // The personal-uniqueness index is partial; the arbiter must match it.
      targetWhere: sql`${goatIntegrations.workspaceId} IS NULL`,
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
    .returning({ id: goatIntegrations.id });

  if (!integration) {
    throw new Error("Could not persist Goat iMessage integration.");
  }

  await captureGoatIntegrationAddedAnalytics({
    userWorkosId: input.userWorkosId,
    provider: "imessage",
  });

  return { integrationId: integration.id };
}

export async function getGoatImessageIntegrationState(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<GoatImessageProviderState> {
  const [row] = await db
    .select({
      id: goatIntegrations.id,
      status: goatIntegrations.status,
      accountName: goatIntegrations.accountName,
      statusReason: goatIntegrations.statusReason,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, GOAT_IMESSAGE_PROVIDER),
        ne(goatIntegrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
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
