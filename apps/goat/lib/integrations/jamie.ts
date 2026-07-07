import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
  saveGoatIntegrationCredential,
} from "@opencompany/db/goat-integrations";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, ne } from "drizzle-orm";
import type { GoatJamieProviderState } from "@/lib/integration-state";
import {
  GOAT_JAMIE_CREDENTIAL_KIND,
  GOAT_JAMIE_PROVIDER,
  GOAT_JAMIE_WEBHOOK_EVENT_HEADER,
  GOAT_JAMIE_WEBHOOK_SECRET_HEADER,
} from "@/lib/integrations/jamie-constants";
import { getGoatAppUrl } from "@/lib/workos";

export {
  GOAT_JAMIE_CREDENTIAL_KIND,
  GOAT_JAMIE_PROVIDER,
  GOAT_JAMIE_WEBHOOK_EVENT_HEADER,
  GOAT_JAMIE_WEBHOOK_SECRET_HEADER,
};

const JAMIE_EXTERNAL_ID = "jamie_webhook";
const JAMIE_SETUP_STATUS_REASON = "Waiting for Jamie to send the first valid webhook delivery.";

type JamieWebhookCredentialPayload = {
  apiKeyHash: string | null;
  legacySecretHash: string | null;
  headerName: typeof GOAT_JAMIE_WEBHOOK_SECRET_HEADER;
  createdAt: string;
};

export type GoatJamieWebhookSetup = {
  integrationId: string;
  webhookUrl: string;
  headerName: typeof GOAT_JAMIE_WEBHOOK_SECRET_HEADER;
};

export type GoatJamieWebhookContext = {
  integrationId: string;
  userWorkosId: string;
  apiKeyHash: string | null;
  legacySecretHash: string | null;
};

export type GoatJamieWebhookApiKeyVerification =
  | { valid: true; shouldBind: boolean; apiKey: string }
  | { valid: false; shouldBind: false; apiKey: null };

export async function getGoatJamieIntegrationState(
  userWorkosId: string,
): Promise<GoatJamieProviderState> {
  const [row] = await getDb()
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
        eq(goatIntegrations.provider, GOAT_JAMIE_PROVIDER),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);

  if (!row || row.status === "disconnected") {
    return {
      provider: GOAT_JAMIE_PROVIDER,
      connected: false,
      status: "not_connected",
      accountName: null,
      statusReason: null,
      integrationId: null,
      webhookUrl: null,
    };
  }

  return {
    provider: GOAT_JAMIE_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    accountName: row.accountName,
    statusReason: row.statusReason,
    integrationId: row.id,
    webhookUrl: goatJamieWebhookUrl(row.id),
  };
}

export async function createOrResetGoatJamieWebhookEndpoint(input: {
  userWorkosId: string;
}): Promise<GoatJamieWebhookSetup> {
  const db = getDb();
  const now = new Date();

  const [integration] = await db
    .insert(goatIntegrations)
    .values({
      id: newGoatIntegrationId(),
      userWorkosId: input.userWorkosId,
      provider: GOAT_JAMIE_PROVIDER,
      externalId: JAMIE_EXTERNAL_ID,
      connectionLabel: "Jamie",
      accountName: "Jamie",
      accountType: "webhook",
      status: "needs_reauth",
      statusReason: JAMIE_SETUP_STATUS_REASON,
      scopes: [],
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        goatIntegrations.userWorkosId,
        goatIntegrations.provider,
        goatIntegrations.externalId,
      ],
      set: {
        connectionLabel: "Jamie",
        accountName: "Jamie",
        accountType: "webhook",
        status: "needs_reauth",
        statusReason: JAMIE_SETUP_STATUS_REASON,
        updatedAt: now,
      },
    })
    .returning({ id: goatIntegrations.id });

  if (!integration) throw new Error("Could not persist Jamie integration.");

  try {
    await saveGoatIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: GOAT_JAMIE_PROVIDER,
      kind: GOAT_JAMIE_CREDENTIAL_KIND,
      payload: {
        apiKeyHash: null,
        headerName: GOAT_JAMIE_WEBHOOK_SECRET_HEADER,
        createdAt: now.toISOString(),
      },
      db,
      now,
    });
  } catch (error) {
    await markGoatIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: GOAT_JAMIE_PROVIDER,
      status: "sync_failed",
      statusReason: "Failed to reset Jamie webhook API key binding.",
      db,
      now: new Date(),
    });
    throw error;
  }

  return {
    integrationId: integration.id,
    webhookUrl: goatJamieWebhookUrl(integration.id),
    headerName: GOAT_JAMIE_WEBHOOK_SECRET_HEADER,
  };
}

export async function loadGoatJamieWebhookContext(
  integrationId: string,
): Promise<GoatJamieWebhookContext | null> {
  const [integration] = await getDb()
    .select({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, integrationId),
        eq(goatIntegrations.provider, GOAT_JAMIE_PROVIDER),
        ne(goatIntegrations.status, "disconnected"),
      ),
    )
    .limit(1);

  if (!integration) return null;

  const credential = await loadGoatIntegrationCredential({
    userWorkosId: integration.userWorkosId,
    integrationId: integration.id,
    provider: GOAT_JAMIE_PROVIDER,
    kind: GOAT_JAMIE_CREDENTIAL_KIND,
  });
  if (!credential) return null;

  const payload = parseJamieWebhookCredentialPayload(credential.payload);
  if (!payload) return null;

  return {
    integrationId: integration.id,
    userWorkosId: integration.userWorkosId,
    apiKeyHash: payload.apiKeyHash,
    legacySecretHash: payload.legacySecretHash,
  };
}

export async function bindGoatJamieWebhookApiKey(input: {
  integrationId: string;
  userWorkosId: string;
  apiKey: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  await saveGoatIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: GOAT_JAMIE_PROVIDER,
    kind: GOAT_JAMIE_CREDENTIAL_KIND,
    payload: {
      apiKeyHash: hashGoatJamieWebhookApiKey(input.apiKey),
      headerName: GOAT_JAMIE_WEBHOOK_SECRET_HEADER,
      createdAt: now.toISOString(),
    },
    now,
  });
}

export async function markGoatJamieWebhookConnected(input: {
  integrationId: string;
  userWorkosId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  await getDb()
    .update(goatIntegrations)
    .set({
      status: "connected",
      statusReason: null,
      connectionLabel: "Jamie",
      accountName: "Jamie",
      accountType: "webhook",
      lastSyncedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(goatIntegrations.id, input.integrationId),
        eq(goatIntegrations.userWorkosId, input.userWorkosId),
        eq(goatIntegrations.provider, GOAT_JAMIE_PROVIDER),
      ),
    );
}

export function verifyGoatJamieWebhookApiKey(input: {
  candidate: string | null;
  apiKeyHash: string | null;
  legacySecretHash?: string | null;
}): GoatJamieWebhookApiKeyVerification {
  if (!input.candidate) return { valid: false, shouldBind: false, apiKey: null };

  if (input.apiKeyHash) {
    return timingSafeHashMatch(input.candidate, input.apiKeyHash)
      ? { valid: true, shouldBind: false, apiKey: input.candidate }
      : { valid: false, shouldBind: false, apiKey: null };
  }

  if (input.legacySecretHash && timingSafeHashMatch(input.candidate, input.legacySecretHash)) {
    return { valid: true, shouldBind: false, apiKey: input.candidate };
  }

  if (!isValidJamieProviderApiKey(input.candidate)) {
    return { valid: false, shouldBind: false, apiKey: null };
  }

  return { valid: true, shouldBind: true, apiKey: input.candidate };
}

export function hashGoatJamieWebhookApiKey(apiKey: string) {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export function isValidJamieProviderApiKey(apiKey: string) {
  return /^sk_[a-f0-9]{64}$/.test(apiKey);
}

function timingSafeHashMatch(candidate: string, expectedHash: string) {
  const candidateHash = hashGoatJamieWebhookApiKey(candidate);
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(candidateHash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function goatJamieWebhookUrl(integrationId: string) {
  return `${getGoatAppUrl()}/api/webhooks/jamie/${integrationId}`;
}

function parseJamieWebhookCredentialPayload(
  value: Record<string, unknown>,
): JamieWebhookCredentialPayload | null {
  if (
    value.headerName !== GOAT_JAMIE_WEBHOOK_SECRET_HEADER ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  if ("secretHash" in value) {
    if (typeof value.secretHash !== "string" || !/^[a-f0-9]{64}$/.test(value.secretHash)) {
      return null;
    }

    return {
      apiKeyHash: null,
      legacySecretHash: value.secretHash,
      headerName: value.headerName,
      createdAt: value.createdAt,
    };
  }

  if (
    value.apiKeyHash !== null &&
    (typeof value.apiKeyHash !== "string" || !/^[a-f0-9]{64}$/.test(value.apiKeyHash))
  ) {
    return null;
  }

  return {
    apiKeyHash: value.apiKeyHash,
    legacySecretHash: null,
    headerName: value.headerName,
    createdAt: value.createdAt,
  };
}

function newGoatIntegrationId() {
  return `gint_${randomUUID().replace(/-/g, "")}`;
}
