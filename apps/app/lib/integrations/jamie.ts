import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  loadIntegrationCredential,
  markIntegrationStatus,
  saveIntegrationCredential,
} from "@opencompany/db/integrations";
import { integrations } from "@opencompany/db/schema";
import { and, desc, eq, ne } from "drizzle-orm";
import type { JamieProviderState } from "@/lib/integration-state";
import {
  JAMIE_CREDENTIAL_KIND,
  JAMIE_PROVIDER,
  JAMIE_WEBHOOK_EVENT_HEADER,
  JAMIE_WEBHOOK_SECRET_HEADER,
} from "@/lib/integrations/jamie-constants";
import { getAppUrl } from "@/lib/workos";

export {
  JAMIE_CREDENTIAL_KIND,
  JAMIE_PROVIDER,
  JAMIE_WEBHOOK_EVENT_HEADER,
  JAMIE_WEBHOOK_SECRET_HEADER,
};

const JAMIE_SETUP_STATUS_REASON = "Waiting for Jamie to send the first valid webhook delivery.";
const JAMIE_UNBOUND_EXTERNAL_ID_PREFIX = "jamie_webhook:";
const JAMIE_API_KEY_EXTERNAL_ID_PREFIX = "jamie_api_key_sha256:";

type JamieWebhookCredentialPayload = {
  apiKeyHash: string | null;
  legacySecretHash: string | null;
  headerName: typeof JAMIE_WEBHOOK_SECRET_HEADER;
  createdAt: string;
};

export type JamieWebhookSetup = {
  integrationId: string;
  webhookUrl: string;
  headerName: typeof JAMIE_WEBHOOK_SECRET_HEADER;
  apiKeyConfigured: boolean;
};

export type JamieWebhookContext = {
  integrationId: string;
  userWorkosId: string;
  apiKeyHash: string | null;
  legacySecretHash: string | null;
};

export type JamieWebhookApiKeyVerification =
  | { valid: true; apiKey: string }
  | { valid: false; apiKey: null };

export async function getJamieIntegrationState(workspaceId: string): Promise<JamieProviderState> {
  const [row] = await getDb()
    .select({
      id: integrations.id,
      externalId: integrations.externalId,
      status: integrations.status,
      accountName: integrations.accountName,
      statusReason: integrations.statusReason,
    })
    .from(integrations)
    .where(
      and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, JAMIE_PROVIDER)),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);

  if (!row || row.status === "disconnected") {
    return {
      provider: JAMIE_PROVIDER,
      connected: false,
      status: "not_connected",
      accountName: null,
      statusReason: null,
      integrationId: null,
      webhookUrl: null,
      apiKeyConfigured: false,
    };
  }

  return {
    provider: JAMIE_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    accountName: row.accountName,
    statusReason: row.statusReason,
    integrationId: row.id,
    webhookUrl: jamieWebhookUrl(),
    apiKeyConfigured: isJamieWebhookApiKeyConfigured({
      status: row.status,
      externalId: row.externalId,
    }),
  };
}

export function isJamieWebhookApiKeyConfigured(input: { status: string; externalId: string }) {
  return (
    input.status === "connected" || input.externalId.startsWith(JAMIE_API_KEY_EXTERNAL_ID_PREFIX)
  );
}

export async function createOrResetJamieWebhookEndpoint(input: {
  userWorkosId: string;
  workspaceId: string;
}): Promise<JamieWebhookSetup> {
  const db = getDb();
  const now = new Date();
  const [existing] = await db
    .select({ id: integrations.id, userWorkosId: integrations.userWorkosId })
    .from(integrations)
    .where(
      and(
        eq(integrations.workspaceId, input.workspaceId),
        eq(integrations.provider, JAMIE_PROVIDER),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);

  const integrationId = existing?.id ?? newIntegrationId();
  // A reset by a different admin keeps the original connector on the row: the
  // credential AAD and brain_sources composite FK are keyed on it.
  const connectorWorkosId = existing?.userWorkosId ?? input.userWorkosId;
  const integrationValues = {
    connectionLabel: "Jamie",
    accountName: "Jamie",
    accountType: "webhook",
    externalId: unboundJamieExternalId(integrationId),
    status: "needs_reauth" as const,
    statusReason: JAMIE_SETUP_STATUS_REASON,
    scopes: [] as string[],
    updatedAt: now,
  };

  const integration = existing
    ? (
        await db
          .update(integrations)
          .set(integrationValues)
          .where(
            and(
              eq(integrations.id, integrationId),
              eq(integrations.workspaceId, input.workspaceId),
              eq(integrations.provider, JAMIE_PROVIDER),
            ),
          )
          .returning({ id: integrations.id })
      )[0]
    : (
        await db
          .insert(integrations)
          .values({
            id: integrationId,
            userWorkosId: connectorWorkosId,
            workspaceId: input.workspaceId,
            provider: JAMIE_PROVIDER,
            ...integrationValues,
          })
          .returning({ id: integrations.id })
      )[0];

  if (!integration) throw new Error("Could not persist Jamie integration.");

  try {
    await saveIntegrationCredential({
      userWorkosId: connectorWorkosId,
      integrationId: integration.id,
      provider: JAMIE_PROVIDER,
      kind: JAMIE_CREDENTIAL_KIND,
      payload: {
        apiKeyHash: null,
        headerName: JAMIE_WEBHOOK_SECRET_HEADER,
        createdAt: now.toISOString(),
      },
      db,
      now,
    });
  } catch (error) {
    await markIntegrationStatus({
      userWorkosId: connectorWorkosId,
      integrationId: integration.id,
      provider: JAMIE_PROVIDER,
      status: "sync_failed",
      statusReason: "Failed to reset Jamie webhook API key binding.",
      db,
      now: new Date(),
    });
    throw error;
  }

  return {
    integrationId: integration.id,
    webhookUrl: jamieWebhookUrl(),
    headerName: JAMIE_WEBHOOK_SECRET_HEADER,
    apiKeyConfigured: false,
  };
}

export async function saveJamieWebhookApiKey(input: {
  workspaceId: string;
  apiKey: string;
}): Promise<JamieWebhookSetup> {
  const apiKey = input.apiKey.trim();
  if (!isValidJamieProviderApiKey(apiKey)) {
    throw new Error("Jamie API keys must start with sk_ followed by 64 lowercase hex characters.");
  }

  const db = getDb();
  const now = new Date();
  const [integration] = await db
    .select({ id: integrations.id, userWorkosId: integrations.userWorkosId })
    .from(integrations)
    .where(
      and(
        eq(integrations.workspaceId, input.workspaceId),
        eq(integrations.provider, JAMIE_PROVIDER),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);

  if (!integration) {
    throw new Error("Create a Jamie webhook endpoint before saving the API key.");
  }

  try {
    // Credential ops key on the row's original connector, not the acting
    // admin: the encrypted payload AAD is bound to that user id.
    await saveIntegrationCredential({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: JAMIE_PROVIDER,
      kind: JAMIE_CREDENTIAL_KIND,
      payload: {
        apiKeyHash: hashJamieWebhookApiKey(apiKey),
        headerName: JAMIE_WEBHOOK_SECRET_HEADER,
        createdAt: now.toISOString(),
      },
      db,
      now,
    });
    await db
      .update(integrations)
      .set({
        externalId: jamieExternalIdForApiKey(apiKey),
        connectionLabel: "Jamie",
        accountName: "Jamie",
        accountType: "webhook",
        status: "needs_reauth",
        statusReason: JAMIE_SETUP_STATUS_REASON,
        updatedAt: now,
      })
      .where(
        and(
          eq(integrations.id, integration.id),
          eq(integrations.workspaceId, input.workspaceId),
          eq(integrations.provider, JAMIE_PROVIDER),
        ),
      );
  } catch (error) {
    await markIntegrationStatus({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: JAMIE_PROVIDER,
      status: "sync_failed",
      statusReason: "Failed to save Jamie webhook API key.",
      db,
      now: new Date(),
    });
    throw error;
  }

  return {
    integrationId: integration.id,
    webhookUrl: jamieWebhookUrl(),
    headerName: JAMIE_WEBHOOK_SECRET_HEADER,
    apiKeyConfigured: true,
  };
}

export async function loadJamieWebhookContext(
  integrationId: string,
): Promise<JamieWebhookContext | null> {
  const [integration] = await getDb()
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.id, integrationId),
        eq(integrations.provider, JAMIE_PROVIDER),
        ne(integrations.status, "disconnected"),
      ),
    )
    .limit(1);

  if (!integration) return null;

  return loadJamieWebhookContextForIntegration(integration);
}

export async function loadJamieWebhookContextForApiKey(
  apiKey: string | null,
): Promise<JamieWebhookContext | null> {
  if (!apiKey || !isValidJamieProviderApiKey(apiKey)) return null;

  const directIntegrations = await getDb()
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.provider, JAMIE_PROVIDER),
        eq(integrations.externalId, jamieExternalIdForApiKey(apiKey)),
        ne(integrations.status, "disconnected"),
      ),
    )
    .limit(2);

  if (directIntegrations.length > 1) return null;
  const [directIntegration] = directIntegrations;
  if (directIntegration) {
    return loadJamieWebhookContextForIntegration(directIntegration);
  }

  const candidateIntegrations = await getDb()
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
    })
    .from(integrations)
    .where(and(eq(integrations.provider, JAMIE_PROVIDER), ne(integrations.status, "disconnected")));

  const matches: JamieWebhookContext[] = [];
  for (const integration of candidateIntegrations) {
    const context = await loadJamieWebhookContextForIntegration(integration);
    if (!context) continue;
    const verification = verifyJamieWebhookApiKey({
      candidate: apiKey,
      apiKeyHash: context.apiKeyHash,
      legacySecretHash: context.legacySecretHash,
    });
    if (verification.valid) matches.push(context);
  }

  if (matches.length !== 1) return null;
  const [matched] = matches;
  if (!matched) return null;

  try {
    await getDb()
      .update(integrations)
      .set({
        externalId: jamieExternalIdForApiKey(apiKey),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrations.id, matched.integrationId),
          eq(integrations.userWorkosId, matched.userWorkosId),
          eq(integrations.provider, JAMIE_PROVIDER),
        ),
      );
  } catch (error) {
    console.warn("[jamie] Failed to backfill Jamie API key lookup hash", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return matched;
}

async function loadJamieWebhookContextForIntegration(integration: {
  id: string;
  userWorkosId: string;
}): Promise<JamieWebhookContext | null> {
  const credential = await loadIntegrationCredential({
    userWorkosId: integration.userWorkosId,
    integrationId: integration.id,
    provider: JAMIE_PROVIDER,
    kind: JAMIE_CREDENTIAL_KIND,
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

export async function markJamieWebhookConnected(input: {
  integrationId: string;
  userWorkosId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  await getDb()
    .update(integrations)
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
        eq(integrations.id, input.integrationId),
        eq(integrations.userWorkosId, input.userWorkosId),
        eq(integrations.provider, JAMIE_PROVIDER),
      ),
    );
}

export function verifyJamieWebhookApiKey(input: {
  candidate: string | null;
  apiKeyHash: string | null;
  legacySecretHash?: string | null;
}): JamieWebhookApiKeyVerification {
  if (!input.candidate) return { valid: false, apiKey: null };

  if (input.apiKeyHash) {
    return timingSafeHashMatch(input.candidate, input.apiKeyHash)
      ? { valid: true, apiKey: input.candidate }
      : { valid: false, apiKey: null };
  }

  if (input.legacySecretHash && timingSafeHashMatch(input.candidate, input.legacySecretHash)) {
    return { valid: true, apiKey: input.candidate };
  }

  return { valid: false, apiKey: null };
}

export function hashJamieWebhookApiKey(apiKey: string) {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export function isValidJamieProviderApiKey(apiKey: string) {
  return /^sk_[a-f0-9]{64}$/.test(apiKey);
}

function timingSafeHashMatch(candidate: string, expectedHash: string) {
  const candidateHash = hashJamieWebhookApiKey(candidate);
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(candidateHash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function jamieWebhookUrl() {
  return `${getAppUrl()}/api/webhooks/jamie`;
}

function parseJamieWebhookCredentialPayload(
  value: Record<string, unknown>,
): JamieWebhookCredentialPayload | null {
  if (value.headerName !== JAMIE_WEBHOOK_SECRET_HEADER || typeof value.createdAt !== "string") {
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

function newIntegrationId() {
  return `gint_${randomUUID().replace(/-/g, "")}`;
}

function unboundJamieExternalId(integrationId: string) {
  return `${JAMIE_UNBOUND_EXTERNAL_ID_PREFIX}${integrationId}`;
}

function jamieExternalIdForApiKey(apiKey: string) {
  return `${JAMIE_API_KEY_EXTERNAL_ID_PREFIX}${hashJamieWebhookApiKey(apiKey)}`;
}
