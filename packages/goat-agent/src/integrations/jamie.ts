import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
  saveGoatIntegrationCredential,
} from "@opencompany/db/goat-integrations";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, ne } from "drizzle-orm";
import { getGoatAppUrl } from "../app-url";
import type { GoatJamieProviderState } from "../integration-state";
import {
  GOAT_JAMIE_CREDENTIAL_KIND,
  GOAT_JAMIE_PROVIDER,
  GOAT_JAMIE_WEBHOOK_EVENT_HEADER,
  GOAT_JAMIE_WEBHOOK_SECRET_HEADER,
} from "./jamie-constants";

export {
  GOAT_JAMIE_CREDENTIAL_KIND,
  GOAT_JAMIE_PROVIDER,
  GOAT_JAMIE_WEBHOOK_EVENT_HEADER,
  GOAT_JAMIE_WEBHOOK_SECRET_HEADER,
};

type DbLike = any;

const JAMIE_SETUP_STATUS_REASON = "Waiting for Jamie to send the first valid webhook delivery.";
const JAMIE_UNBOUND_EXTERNAL_ID_PREFIX = "jamie_webhook:";
const JAMIE_API_KEY_EXTERNAL_ID_PREFIX = "jamie_api_key_sha256:";

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
  apiKeyConfigured: boolean;
};

export type GoatJamieWebhookContext = {
  integrationId: string;
  userWorkosId: string;
  apiKeyHash: string | null;
  legacySecretHash: string | null;
};

export type GoatJamieWebhookApiKeyVerification =
  | { valid: true; apiKey: string }
  | { valid: false; apiKey: null };

export async function getGoatJamieIntegrationState(
  workspaceId: string,
): Promise<GoatJamieProviderState> {
  const [row] = await getDb()
    .select({
      id: goatIntegrations.id,
      externalId: goatIntegrations.externalId,
      status: goatIntegrations.status,
      accountName: goatIntegrations.accountName,
      statusReason: goatIntegrations.statusReason,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.workspaceId, workspaceId),
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
      apiKeyConfigured: false,
    };
  }

  return {
    provider: GOAT_JAMIE_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    accountName: row.accountName,
    statusReason: row.statusReason,
    integrationId: row.id,
    webhookUrl: goatJamieWebhookUrl(),
    apiKeyConfigured: isGoatJamieWebhookApiKeyConfigured({
      status: row.status,
      externalId: row.externalId,
    }),
  };
}

export function isGoatJamieWebhookApiKeyConfigured(input: { status: string; externalId: string }) {
  return (
    input.status === "connected" || input.externalId.startsWith(JAMIE_API_KEY_EXTERNAL_ID_PREFIX)
  );
}

export async function createOrResetGoatJamieWebhookEndpoint(input: {
  userWorkosId: string;
  workspaceId: string;
}): Promise<GoatJamieWebhookSetup> {
  const db = getDb();
  const now = new Date();
  const [existing] = await db
    .select({ id: goatIntegrations.id, userWorkosId: goatIntegrations.userWorkosId })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.workspaceId, input.workspaceId),
        eq(goatIntegrations.provider, GOAT_JAMIE_PROVIDER),
        ne(goatIntegrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);

  const integrationId = existing?.id ?? newGoatIntegrationId();
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
          .update(goatIntegrations)
          .set(integrationValues)
          .where(
            and(
              eq(goatIntegrations.id, integrationId),
              eq(goatIntegrations.workspaceId, input.workspaceId),
              eq(goatIntegrations.provider, GOAT_JAMIE_PROVIDER),
            ),
          )
          .returning({ id: goatIntegrations.id })
      )[0]
    : (
        await db
          .insert(goatIntegrations)
          .values({
            id: integrationId,
            userWorkosId: connectorWorkosId,
            workspaceId: input.workspaceId,
            provider: GOAT_JAMIE_PROVIDER,
            ...integrationValues,
          })
          .returning({ id: goatIntegrations.id })
      )[0];

  if (!integration) throw new Error("Could not persist Jamie integration.");

  try {
    await saveGoatIntegrationCredential({
      userWorkosId: connectorWorkosId,
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
      userWorkosId: connectorWorkosId,
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
    webhookUrl: goatJamieWebhookUrl(),
    headerName: GOAT_JAMIE_WEBHOOK_SECRET_HEADER,
    apiKeyConfigured: false,
  };
}

export async function saveGoatJamieWebhookApiKey(input: {
  workspaceId: string;
  apiKey: string;
}): Promise<GoatJamieWebhookSetup> {
  const apiKey = input.apiKey.trim();
  if (!isValidJamieProviderApiKey(apiKey)) {
    throw new Error("Jamie API keys must start with sk_ followed by 64 lowercase hex characters.");
  }

  const db = getDb();
  const now = new Date();
  const [integration] = await db
    .select({ id: goatIntegrations.id, userWorkosId: goatIntegrations.userWorkosId })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.workspaceId, input.workspaceId),
        eq(goatIntegrations.provider, GOAT_JAMIE_PROVIDER),
        ne(goatIntegrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);

  if (!integration) {
    throw new Error("Create a Jamie webhook endpoint before saving the API key.");
  }

  try {
    // Credential ops key on the row's original connector, not the acting
    // admin: the encrypted payload AAD is bound to that user id.
    await saveGoatIntegrationCredential({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: GOAT_JAMIE_PROVIDER,
      kind: GOAT_JAMIE_CREDENTIAL_KIND,
      payload: {
        apiKeyHash: hashGoatJamieWebhookApiKey(apiKey),
        headerName: GOAT_JAMIE_WEBHOOK_SECRET_HEADER,
        createdAt: now.toISOString(),
      },
      db,
      now,
    });
    await db
      .update(goatIntegrations)
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
          eq(goatIntegrations.id, integration.id),
          eq(goatIntegrations.workspaceId, input.workspaceId),
          eq(goatIntegrations.provider, GOAT_JAMIE_PROVIDER),
        ),
      );
  } catch (error) {
    await markGoatIntegrationStatus({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: GOAT_JAMIE_PROVIDER,
      status: "sync_failed",
      statusReason: "Failed to save Jamie webhook API key.",
      db,
      now: new Date(),
    });
    throw error;
  }

  return {
    integrationId: integration.id,
    webhookUrl: goatJamieWebhookUrl(),
    headerName: GOAT_JAMIE_WEBHOOK_SECRET_HEADER,
    apiKeyConfigured: true,
  };
}

export async function loadGoatJamieWebhookContext(
  integrationId: string,
  db: DbLike = getDb(),
): Promise<GoatJamieWebhookContext | null> {
  const [integration] = await db
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

  return loadGoatJamieWebhookContextForIntegration(integration, db);
}

export async function loadGoatJamieWebhookContextForApiKey(
  apiKey: string | null,
  db: DbLike = getDb(),
): Promise<GoatJamieWebhookContext | null> {
  if (!apiKey || !isValidJamieProviderApiKey(apiKey)) return null;

  const directIntegrations = await db
    .select({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.provider, GOAT_JAMIE_PROVIDER),
        eq(goatIntegrations.externalId, jamieExternalIdForApiKey(apiKey)),
        ne(goatIntegrations.status, "disconnected"),
      ),
    )
    .limit(2);

  if (directIntegrations.length > 1) return null;
  const [directIntegration] = directIntegrations;
  if (directIntegration) {
    return loadGoatJamieWebhookContextForIntegration(directIntegration, db);
  }

  const integrations = await db
    .select({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.provider, GOAT_JAMIE_PROVIDER),
        ne(goatIntegrations.status, "disconnected"),
      ),
    );

  const matches: GoatJamieWebhookContext[] = [];
  for (const integration of integrations) {
    const context = await loadGoatJamieWebhookContextForIntegration(integration, db);
    if (!context) continue;
    const verification = verifyGoatJamieWebhookApiKey({
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
    await db
      .update(goatIntegrations)
      .set({
        externalId: jamieExternalIdForApiKey(apiKey),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(goatIntegrations.id, matched.integrationId),
          eq(goatIntegrations.userWorkosId, matched.userWorkosId),
          eq(goatIntegrations.provider, GOAT_JAMIE_PROVIDER),
        ),
      );
  } catch (error) {
    console.warn("[goat-jamie] Failed to backfill Jamie API key lookup hash", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return matched;
}

async function loadGoatJamieWebhookContextForIntegration(
  integration: {
    id: string;
    userWorkosId: string;
  },
  db: DbLike = getDb(),
): Promise<GoatJamieWebhookContext | null> {
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: integration.userWorkosId,
    integrationId: integration.id,
    provider: GOAT_JAMIE_PROVIDER,
    kind: GOAT_JAMIE_CREDENTIAL_KIND,
    db,
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

export async function markGoatJamieWebhookConnected(
  input: {
    integrationId: string;
    userWorkosId: string;
    now?: Date;
  },
  db: DbLike = getDb(),
) {
  const now = input.now ?? new Date();
  await db
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

export function goatJamieWebhookUrl() {
  return `${getGoatAppUrl()}/api/webhooks/jamie`;
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

function unboundJamieExternalId(integrationId: string) {
  return `${JAMIE_UNBOUND_EXTERNAL_ID_PREFIX}${integrationId}`;
}

function jamieExternalIdForApiKey(apiKey: string) {
  return `${JAMIE_API_KEY_EXTERNAL_ID_PREFIX}${hashGoatJamieWebhookApiKey(apiKey)}`;
}
