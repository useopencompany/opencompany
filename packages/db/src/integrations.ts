import { randomUUID } from "node:crypto";
import {
  buildAad,
  DEFAULT_ENCRYPTION_KEY_VERSION,
  decryptJson,
  encryptJson,
  loadEncryptionKey,
} from "@opencompany/crypto";
import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { getDb } from "./client";
import type * as schema from "./schema";
import {
  type IntegrationCredentialKind,
  type IntegrationProvider,
  integrationCredentials,
  integrations,
} from "./schema";

export type GoogleOAuthTokens = {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
};

type DbSchema = typeof schema;
type IntegrationDb = Pick<PgDatabase<PgQueryResultHKT, DbSchema>, "insert" | "select" | "update">;
type IntegrationTransactionalDb = IntegrationDb & {
  transaction<T>(callback: (tx: IntegrationDb) => Promise<T>): Promise<T>;
};
type IntegrationBatchDb = Pick<ReturnType<typeof getDb>, "batch" | "insert" | "select" | "update">;
type IntegrationRefreshDb = IntegrationTransactionalDb | IntegrationBatchDb;
const INTEGRATION_CREDENTIAL_WRITE_RETURNING = {
  id: integrationCredentials.id,
  expiresAt: integrationCredentials.expiresAt,
  lastRotatedAt: integrationCredentials.lastRotatedAt,
  updatedAt: integrationCredentials.updatedAt,
  encryptionKeyVersion: integrationCredentials.encryptionKeyVersion,
} as const;

export type IntegrationCredentialContext = {
  userWorkosId: string;
  integrationId: string;
  provider: IntegrationProvider;
  kind: IntegrationCredentialKind;
};

export type LoadedIntegrationCredential = {
  payload: Record<string, unknown>;
  expiresAt: Date | null;
  lastRotatedAt: Date | null;
  updatedAt: Date;
  encryptionKeyVersion: number;
};

export async function connectGoogleIntegration(input: {
  provider: IntegrationProvider;
  userWorkosId: string;
  externalId: string;
  accountEmail: string | null;
  accountName: string | null;
  tokens: GoogleOAuthTokens;
  expiresAt: Date | null;
  scopes: string[];
  db?: IntegrationDb;
  now?: Date;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const connectionLabel = input.accountEmail?.trim() || input.accountName?.trim() || "Google";

  const [integration] = await db
    .insert(integrations)
    .values({
      id: newIntegrationId(),
      userWorkosId: input.userWorkosId,
      provider: input.provider,
      externalId: input.externalId,
      connectionLabel,
      accountName: input.accountName,
      accountEmail: input.accountEmail,
      accountType: "google_account",
      status: "connected",
      statusReason: null,
      scopes: input.scopes,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [integrations.userWorkosId, integrations.provider, integrations.externalId],
      // The personal-uniqueness index is partial; the arbiter must match it.
      targetWhere: sql`${integrations.workspaceId} IS NULL`,
      set: {
        connectionLabel,
        accountName: input.accountName,
        accountEmail: input.accountEmail,
        accountType: "google_account",
        status: "connected",
        statusReason: null,
        scopes: input.scopes,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: integrations.id });

  if (!integration) {
    throw new Error("Could not persist Goat Google integration.");
  }

  try {
    await saveIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: input.provider,
      kind: "oauth_token",
      payload: { ...input.tokens },
      expiresAt: input.expiresAt,
      db,
      now,
    });
  } catch (error) {
    await markIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: input.provider,
      status: "sync_failed",
      statusReason: "Failed to persist Google integration credentials.",
      db,
      now: new Date(),
    });
    throw error;
  }

  return { integrationId: integration.id };
}

export type SlackOAuthCredentialPayload = {
  access_token: string;
  authed_user_id: string;
  team_id: string;
  team_name?: string;
  team_domain?: string;
  scope?: string;
};

export async function connectSlackIntegration(input: {
  userWorkosId: string;
  teamId: string;
  teamName: string | null;
  teamDomain: string | null;
  authedUserId: string;
  accountName: string | null;
  accountEmail: string | null;
  accessToken: string;
  scopes: string[];
  db?: IntegrationDb;
  now?: Date;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const connectionLabel = input.teamName?.trim() || "Slack";

  const [integration] = await db
    .insert(integrations)
    .values({
      id: newIntegrationId(),
      userWorkosId: input.userWorkosId,
      provider: "slack",
      // The Slack team id is the routing key for inbound events.
      externalId: input.teamId,
      connectionLabel,
      accountName: input.accountName,
      accountEmail: input.accountEmail,
      accountType: "slack_user",
      status: "connected",
      statusReason: null,
      scopes: input.scopes,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [integrations.userWorkosId, integrations.provider, integrations.externalId],
      // The personal-uniqueness index is partial; the arbiter must match it.
      targetWhere: sql`${integrations.workspaceId} IS NULL`,
      set: {
        connectionLabel,
        accountName: input.accountName,
        accountEmail: input.accountEmail,
        accountType: "slack_user",
        status: "connected",
        statusReason: null,
        scopes: input.scopes,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: integrations.id });

  if (!integration) {
    throw new Error("Could not persist Goat Slack integration.");
  }

  const payload: SlackOAuthCredentialPayload = {
    access_token: input.accessToken,
    authed_user_id: input.authedUserId,
    team_id: input.teamId,
    ...(input.teamName ? { team_name: input.teamName } : {}),
    ...(input.teamDomain ? { team_domain: input.teamDomain } : {}),
    ...(input.scopes.length > 0 ? { scope: input.scopes.join(",") } : {}),
  };

  try {
    await saveIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: "slack",
      kind: "oauth_token",
      payload,
      // Slack user tokens do not expire unless token rotation is opted in.
      expiresAt: null,
      db,
      now,
    });
  } catch (error) {
    await markIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: "slack",
      status: "sync_failed",
      statusReason: "Failed to persist Slack integration credentials.",
      db,
      now: new Date(),
    });
    throw error;
  }

  return { integrationId: integration.id };
}

export type SlackBotOAuthCredentialPayload = {
  access_token: string;
  bot_user_id: string;
  team_id: string;
  team_name?: string;
  scope?: string;
};

// The Slack answer-bot install. Workspace-owned (see
// WORKSPACE_OWNED_INTEGRATION_PROVIDERS): the bot token belongs to the
// Slack workspace install, not to the connecting admin.
export async function connectSlackBotIntegration(input: {
  userWorkosId: string;
  workspaceId: string;
  teamId: string;
  teamName: string | null;
  botUserId: string;
  accessToken: string;
  scopes: string[];
  db?: IntegrationBatchDb;
  now?: Date;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const connectionLabel = input.teamName?.trim() || "Slack";

  // Neon's HTTP driver makes a batch transactional but cannot feed one
  // statement's RETURNING values into the next query. Resolve the stable id
  // and original connector first so the integration and encrypted credential
  // can still be committed atomically below.
  const [existing] = await db
    .select({ id: integrations.id, userWorkosId: integrations.userWorkosId })
    .from(integrations)
    .where(
      and(eq(integrations.workspaceId, input.workspaceId), eq(integrations.provider, "slack_bot")),
    )
    .limit(1);
  const integrationId = existing?.id ?? newIntegrationId();
  const integrationUserWorkosId = existing?.userWorkosId ?? input.userWorkosId;

  const payload: SlackBotOAuthCredentialPayload = {
    access_token: input.accessToken,
    bot_user_id: input.botUserId,
    team_id: input.teamId,
    ...(input.teamName ? { team_name: input.teamName } : {}),
    ...(input.scopes.length > 0 ? { scope: input.scopes.join(",") } : {}),
  };

  const credentialWrite = prepareIntegrationCredentialWrite(
    {
      userWorkosId: integrationUserWorkosId,
      integrationId,
      provider: "slack_bot",
      kind: "oauth_token",
      payload,
      // Bot tokens do not expire unless token rotation is opted in.
      expiresAt: null,
    },
    now,
  );

  const [integrationRows, credentialRows] = await db.batch([
    db
      .insert(integrations)
      .values({
        id: integrationId,
        userWorkosId: integrationUserWorkosId,
        workspaceId: input.workspaceId,
        provider: "slack_bot",
        // The Slack team id is the routing key for inbound bot events.
        externalId: input.teamId,
        connectionLabel,
        accountName: input.teamName,
        accountEmail: null,
        accountType: "slack_bot",
        status: "connected",
        statusReason: null,
        scopes: input.scopes,
        lastSyncedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [integrations.workspaceId, integrations.provider],
        targetWhere: sql`${integrations.workspaceId} IS NOT NULL AND ${integrations.provider} = 'slack_bot'`,
        // On reconnect (possibly by a different admin) user_workos_id stays as
        // the original connector: credential AAD and brain_sources FKs use it.
        set: {
          externalId: input.teamId,
          connectionLabel,
          accountName: input.teamName,
          accountType: "slack_bot",
          status: "connected",
          statusReason: null,
          scopes: input.scopes,
          lastSyncedAt: now,
          updatedAt: now,
        },
      })
      .returning({ id: integrations.id }),
    db
      .insert(integrationCredentials)
      .values(credentialWrite.values)
      .onConflictDoUpdate({
        target: [integrationCredentials.integrationId, integrationCredentials.kind],
        set: credentialWrite.conflictSet,
      })
      .returning(INTEGRATION_CREDENTIAL_WRITE_RETURNING),
  ] as const);

  const integration = integrationRows[0];
  if (!integration || !credentialRows[0]) {
    throw new Error("Could not persist Goat Slack bot integration and credential.");
  }

  return { integrationId: integration.id };
}

export type LinearOAuthCredentialPayload = {
  access_token: string;
  organization_id: string;
  organization_name?: string;
  organization_url_key?: string;
  viewer_id?: string;
  viewer_name?: string;
  scope?: string;
};

// The Linear ingestion connection. Distinct from the Linear MCP connector,
// which shares provider "linear" but keys external_id on the "linear_mcp"
// sentinel; ingestion rows key on the Linear organization id so inbound
// webhooks can route by payload organizationId.
export async function connectLinearIngestIntegration(input: {
  userWorkosId: string;
  organizationId: string;
  organizationName: string | null;
  organizationUrlKey: string | null;
  viewerId: string | null;
  viewerName: string | null;
  viewerEmail: string | null;
  accessToken: string;
  scopes: string[];
  db?: IntegrationDb;
  now?: Date;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const connectionLabel = input.organizationName?.trim() || "Linear";

  const [integration] = await db
    .insert(integrations)
    .values({
      id: newIntegrationId(),
      userWorkosId: input.userWorkosId,
      provider: "linear",
      // The Linear organization id is the routing key for inbound webhooks.
      externalId: input.organizationId,
      connectionLabel,
      accountName: input.viewerName,
      accountEmail: input.viewerEmail,
      accountType: "linear_user",
      status: "connected",
      statusReason: null,
      scopes: input.scopes,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [integrations.userWorkosId, integrations.provider, integrations.externalId],
      // The personal-uniqueness index is partial; the arbiter must match it.
      targetWhere: sql`${integrations.workspaceId} IS NULL`,
      set: {
        connectionLabel,
        accountName: input.viewerName,
        accountEmail: input.viewerEmail,
        accountType: "linear_user",
        status: "connected",
        statusReason: null,
        scopes: input.scopes,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: integrations.id });

  if (!integration) {
    throw new Error("Could not persist Goat Linear integration.");
  }

  const payload: LinearOAuthCredentialPayload = {
    access_token: input.accessToken,
    organization_id: input.organizationId,
    ...(input.organizationName ? { organization_name: input.organizationName } : {}),
    ...(input.organizationUrlKey ? { organization_url_key: input.organizationUrlKey } : {}),
    ...(input.viewerId ? { viewer_id: input.viewerId } : {}),
    ...(input.viewerName ? { viewer_name: input.viewerName } : {}),
    ...(input.scopes.length > 0 ? { scope: input.scopes.join(",") } : {}),
  };

  try {
    await saveIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: "linear",
      kind: "oauth_token",
      payload,
      // Linear OAuth access tokens do not expire.
      expiresAt: null,
      db,
      now,
    });
  } catch (error) {
    await markIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: "linear",
      status: "sync_failed",
      statusReason: "Failed to persist Linear integration credentials.",
      db,
      now: new Date(),
    });
    throw error;
  }

  return { integrationId: integration.id };
}

export type HubspotOAuthCredentialPayload = {
  access_token: string;
  refresh_token: string;
  portal_id: string;
  hub_domain?: string;
  user_email?: string;
  scope?: string;
};

// The HubSpot ingestion connection. Rows key external_id on the HubSpot portal
// (hub) id so inbound webhooks can route by payload portalId. Unlike Linear,
// HubSpot access tokens are short-lived; the runner refreshes them from the
// stored refresh token, so expiresAt is always set.
export async function connectHubspotIntegration(input: {
  userWorkosId: string;
  portalId: string;
  hubDomain: string | null;
  userEmail: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  scopes: string[];
  db?: IntegrationDb;
  now?: Date;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const connectionLabel = input.hubDomain?.trim() || "HubSpot";

  const [integration] = await db
    .insert(integrations)
    .values({
      id: newIntegrationId(),
      userWorkosId: input.userWorkosId,
      provider: "hubspot",
      // The HubSpot portal id is the routing key for inbound webhooks.
      externalId: input.portalId,
      connectionLabel,
      accountName: null,
      accountEmail: input.userEmail,
      accountType: "hubspot_user",
      status: "connected",
      statusReason: null,
      scopes: input.scopes,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [integrations.userWorkosId, integrations.provider, integrations.externalId],
      // The personal-uniqueness index is partial; the arbiter must match it.
      targetWhere: sql`${integrations.workspaceId} IS NULL`,
      set: {
        connectionLabel,
        accountEmail: input.userEmail,
        accountType: "hubspot_user",
        status: "connected",
        statusReason: null,
        scopes: input.scopes,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: integrations.id });

  if (!integration) {
    throw new Error("Could not persist Goat HubSpot integration.");
  }

  const payload: HubspotOAuthCredentialPayload = {
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    portal_id: input.portalId,
    ...(input.hubDomain ? { hub_domain: input.hubDomain } : {}),
    ...(input.userEmail ? { user_email: input.userEmail } : {}),
    ...(input.scopes.length > 0 ? { scope: input.scopes.join(" ") } : {}),
  };

  try {
    await saveIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: "hubspot",
      kind: "oauth_token",
      payload,
      expiresAt: input.expiresAt,
      db,
      now,
    });
  } catch (error) {
    await markIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: "hubspot",
      status: "sync_failed",
      statusReason: "Failed to persist HubSpot integration credentials.",
      db,
      now: new Date(),
    });
    throw error;
  }

  return { integrationId: integration.id };
}

export async function saveIntegrationCredential(
  input: IntegrationCredentialContext & {
    payload: Record<string, unknown>;
    expiresAt?: Date | null;
    db?: IntegrationDb;
    now?: Date;
  },
) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const write = prepareIntegrationCredentialWrite(input, now);

  const [credential] = await db
    .insert(integrationCredentials)
    .values(write.values)
    .onConflictDoUpdate({
      target: [integrationCredentials.integrationId, integrationCredentials.kind],
      set: write.conflictSet,
    })
    .returning(INTEGRATION_CREDENTIAL_WRITE_RETURNING);

  if (!credential) {
    throw new Error("Could not persist Goat integration credential.");
  }

  return credential;
}

export async function refreshIntegrationCredential(
  input: IntegrationCredentialContext & {
    payload: Record<string, unknown>;
    expiresAt?: Date | null;
    db: IntegrationRefreshDb;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const write = prepareIntegrationCredentialWrite(input, now);

  // neon-http cannot open an interactive transaction, but its batch API sends
  // all queries through Neon's transactional HTTP endpoint. The runner's
  // pooled driver keeps using a regular interactive transaction below.
  if ("batch" in input.db) {
    const [credentials] = await input.db.batch([
      input.db
        .insert(integrationCredentials)
        .values(write.values)
        .onConflictDoUpdate({
          target: [integrationCredentials.integrationId, integrationCredentials.kind],
          set: write.conflictSet,
        })
        .returning(INTEGRATION_CREDENTIAL_WRITE_RETURNING),
      input.db
        .update(integrations)
        .set({ status: "connected", statusReason: null, updatedAt: now })
        .where(
          and(
            eq(integrations.userWorkosId, input.userWorkosId),
            eq(integrations.id, input.integrationId),
            eq(integrations.provider, input.provider),
          ),
        ),
    ] as const);
    const credential = credentials[0];

    if (!credential) {
      throw new Error("Could not refresh Goat integration credential.");
    }

    return credential;
  }

  return input.db.transaction(async (tx) => {
    const credential = await saveIntegrationCredential({ ...input, db: tx, now });
    await markIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: input.integrationId,
      provider: input.provider,
      status: "connected",
      statusReason: null,
      db: tx,
      now,
    });
    return credential;
  });
}

function prepareIntegrationCredentialWrite(
  input: IntegrationCredentialContext & {
    payload: Record<string, unknown>;
    expiresAt?: Date | null;
  },
  now: Date,
) {
  const keyVersion = DEFAULT_ENCRYPTION_KEY_VERSION;
  const encryptedPayload = encryptJson(input.payload, {
    key: loadEncryptionKey(keyVersion),
    aad: credentialAad({
      userWorkosId: input.userWorkosId,
      integrationId: input.integrationId,
      provider: input.provider,
      kind: input.kind,
      keyVersion,
    }),
  });

  return {
    values: {
      id: newIntegrationCredentialId(),
      userWorkosId: input.userWorkosId,
      integrationId: input.integrationId,
      provider: input.provider,
      kind: input.kind,
      encryptedPayload,
      encryptionKeyVersion: keyVersion,
      expiresAt: input.expiresAt ?? null,
      lastRotatedAt: now,
      updatedAt: now,
    },
    conflictSet: {
      userWorkosId: input.userWorkosId,
      provider: input.provider,
      encryptedPayload,
      encryptionKeyVersion: keyVersion,
      expiresAt: input.expiresAt ?? null,
      lastRotatedAt: now,
      updatedAt: now,
    },
  };
}

export async function loadIntegrationCredential(
  input: IntegrationCredentialContext & { db?: Pick<ReturnType<typeof getDb>, "select"> },
): Promise<LoadedIntegrationCredential | null> {
  const db = input.db ?? getDb();
  const [credential] = await db
    .select({
      userWorkosId: integrationCredentials.userWorkosId,
      integrationId: integrationCredentials.integrationId,
      provider: integrationCredentials.provider,
      kind: integrationCredentials.kind,
      encryptedPayload: integrationCredentials.encryptedPayload,
      encryptionKeyVersion: integrationCredentials.encryptionKeyVersion,
      expiresAt: integrationCredentials.expiresAt,
      lastRotatedAt: integrationCredentials.lastRotatedAt,
      updatedAt: integrationCredentials.updatedAt,
    })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.userWorkosId, input.userWorkosId),
        eq(integrationCredentials.integrationId, input.integrationId),
        eq(integrationCredentials.provider, input.provider),
        eq(integrationCredentials.kind, input.kind),
      ),
    )
    .limit(1);

  if (!credential) return null;

  return {
    payload: decryptJson(credential.encryptedPayload, {
      key: loadEncryptionKey(credential.encryptionKeyVersion),
      aad: credentialAad({
        userWorkosId: input.userWorkosId,
        integrationId: input.integrationId,
        provider: input.provider,
        kind: input.kind,
        keyVersion: credential.encryptionKeyVersion,
      }),
    }),
    expiresAt: credential.expiresAt,
    lastRotatedAt: credential.lastRotatedAt,
    updatedAt: credential.updatedAt,
    encryptionKeyVersion: credential.encryptionKeyVersion,
  };
}

export async function markIntegrationStatus(input: {
  userWorkosId: string;
  integrationId: string;
  provider: IntegrationProvider;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected";
  statusReason?: string | null;
  db?: Pick<IntegrationDb, "update">;
  now?: Date;
}) {
  await (input.db ?? getDb())
    .update(integrations)
    .set({
      status: input.status,
      statusReason: input.statusReason ? input.statusReason.slice(0, 240) : null,
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(integrations.userWorkosId, input.userWorkosId),
        eq(integrations.id, input.integrationId),
        eq(integrations.provider, input.provider),
      ),
    );
}

export function credentialAad(input: IntegrationCredentialContext & { keyVersion: number }) {
  return buildAad({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: input.provider,
    kind: input.kind,
    keyVersion: input.keyVersion,
  });
}

function newIntegrationId() {
  return `gint_${randomUUID().replace(/-/g, "")}`;
}

function newIntegrationCredentialId() {
  return `gcred_${randomUUID().replace(/-/g, "")}`;
}
