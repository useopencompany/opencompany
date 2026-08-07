import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  ensureFathomSyncState,
  FATHOM_CREDENTIAL_KIND,
  FATHOM_PROVIDER,
} from "@opencompany/db/fathom";
import { markIntegrationStatus, saveIntegrationCredential } from "@opencompany/db/integrations";
import { integrations } from "@opencompany/db/schema";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { FathomProviderState } from "@/lib/integration-state";
import { captureIntegrationAddedAnalytics } from "@/lib/integrations/analytics";

export const FATHOM_API_BASE_URL = "https://api.fathom.ai/external/v1";

export type FathomApiKeyCredentialPayload = {
  apiKey: string;
  createdAt: string;
};

// One Fathom connection per user: the key is minted per person in Fathom's
// user settings, so the personal-uniqueness index keys on this stable sentinel
// and a key rotation updates the row in place instead of minting a sibling.
export function fathomExternalIdForUser(userWorkosId: string) {
  return `fathom:${userWorkosId}`;
}

// Fathom publishes no key format; only reject strings that are clearly not a
// pasted key (whitespace, absurd lengths) and let the API call be the judge.
export function isValidFathomApiKey(apiKey: string) {
  return /^\S{16,500}$/.test(apiKey);
}

export type FathomApiKeyValidation = { ok: true } | { ok: false; error: string };

// Fathom has no identity endpoint; a bare meetings list call (no transcript or
// summary payloads) proves the key works without pulling meeting content.
export async function validateFathomApiKey(apiKey: string): Promise<FathomApiKeyValidation> {
  let response: Response;
  try {
    response = await fetch(`${FATHOM_API_BASE_URL}/meetings`, {
      headers: { "X-Api-Key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, error: "Could not reach the Fathom API. Try again in a moment." };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: "Fathom rejected this API key. Check it and try again." };
  }
  if (!response.ok) {
    return { ok: false, error: `Fathom API returned an unexpected error (${response.status}).` };
  }
  return { ok: true };
}

export async function connectFathomIntegration(input: {
  userWorkosId: string;
  apiKey: string;
  now?: Date;
}): Promise<{ integrationId: string }> {
  const db = getDb();
  const now = input.now ?? new Date();

  const [integration] = await db
    .insert(integrations)
    .values({
      id: newIntegrationId(),
      userWorkosId: input.userWorkosId,
      provider: FATHOM_PROVIDER,
      externalId: fathomExternalIdForUser(input.userWorkosId),
      connectionLabel: "Fathom",
      accountName: null,
      accountEmail: null,
      accountType: "fathom_api_key",
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
        connectionLabel: "Fathom",
        accountType: "fathom_api_key",
        status: "connected",
        statusReason: null,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: integrations.id });

  if (!integration) {
    throw new Error("Could not persist Fathom integration.");
  }

  const payload: FathomApiKeyCredentialPayload = {
    apiKey: input.apiKey,
    createdAt: now.toISOString(),
  };

  try {
    await saveIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: FATHOM_PROVIDER,
      kind: FATHOM_CREDENTIAL_KIND,
      payload,
      // Fathom API keys do not expire; users revoke them in Fathom settings.
      expiresAt: null,
      db,
      now,
    });
  } catch (error) {
    await markIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: FATHOM_PROVIDER,
      status: "sync_failed",
      statusReason: "Failed to persist Fathom integration credentials.",
      db,
      now: new Date(),
    });
    throw error;
  }

  // Anchor the poll cursor row now so the first runner poll starts from the
  // moment of connection (no backfill) without racing the credential write.
  await ensureFathomSyncState(
    {
      integrationId: integration.id,
      userWorkosId: input.userWorkosId,
      createdAfterCursor: now,
    },
    db,
  );

  await captureIntegrationAddedAnalytics({
    userWorkosId: input.userWorkosId,
    provider: "fathom",
  });

  return { integrationId: integration.id };
}

export async function getFathomIntegrationState(
  userWorkosId: string,
): Promise<FathomProviderState> {
  const [row] = await getDb()
    .select({
      id: integrations.id,
      status: integrations.status,
      accountEmail: integrations.accountEmail,
      accountName: integrations.accountName,
      statusReason: integrations.statusReason,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.provider, FATHOM_PROVIDER),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);

  if (!row) {
    return {
      provider: "fathom",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountEmail: null,
      accountName: null,
      statusReason: null,
    };
  }

  return {
    provider: "fathom",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    accountEmail: row.accountEmail,
    accountName: row.accountName,
    statusReason: row.statusReason,
  };
}

function newIntegrationId() {
  return `gint_${randomUUID().replace(/-/g, "")}`;
}
