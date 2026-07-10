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
import type * as goatSchema from "./goat-schema";
import {
  type GoatIntegrationCredentialKind,
  type GoatIntegrationProvider,
  goatIntegrationCredentials,
  goatIntegrations,
} from "./goat-schema";
import type * as publicSchema from "./schema";

export type GoatGoogleOAuthTokens = {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
};

type DbSchema = typeof publicSchema & typeof goatSchema;
type GoatIntegrationDb = Pick<
  PgDatabase<PgQueryResultHKT, DbSchema>,
  "insert" | "select" | "update"
>;
type GoatIntegrationRootDb = GoatIntegrationDb & {
  transaction<T>(callback: (tx: GoatIntegrationDb) => Promise<T>): Promise<T>;
};

export type GoatIntegrationCredentialContext = {
  userWorkosId: string;
  integrationId: string;
  provider: GoatIntegrationProvider;
  kind: GoatIntegrationCredentialKind;
};

export type LoadedGoatIntegrationCredential = {
  payload: Record<string, unknown>;
  expiresAt: Date | null;
  lastRotatedAt: Date | null;
  updatedAt: Date;
  encryptionKeyVersion: number;
};

export async function connectGoatGoogleIntegration(input: {
  provider: GoatIntegrationProvider;
  userWorkosId: string;
  externalId: string;
  accountEmail: string | null;
  accountName: string | null;
  tokens: GoatGoogleOAuthTokens;
  expiresAt: Date | null;
  scopes: string[];
  db?: GoatIntegrationDb;
  now?: Date;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const connectionLabel = input.accountEmail?.trim() || input.accountName?.trim() || "Google";

  const [integration] = await db
    .insert(goatIntegrations)
    .values({
      id: newGoatIntegrationId(),
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
      target: [
        goatIntegrations.userWorkosId,
        goatIntegrations.provider,
        goatIntegrations.externalId,
      ],
      // The personal-uniqueness index is partial; the arbiter must match it.
      targetWhere: sql`${goatIntegrations.workspaceId} IS NULL`,
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
    .returning({ id: goatIntegrations.id });

  if (!integration) {
    throw new Error("Could not persist Goat Google integration.");
  }

  try {
    await saveGoatIntegrationCredential({
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
    await markGoatIntegrationStatus({
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

export type GoatSlackOAuthCredentialPayload = {
  access_token: string;
  authed_user_id: string;
  team_id: string;
  team_name?: string;
  team_domain?: string;
  scope?: string;
};

export async function connectGoatSlackIntegration(input: {
  userWorkosId: string;
  teamId: string;
  teamName: string | null;
  teamDomain: string | null;
  authedUserId: string;
  accountName: string | null;
  accountEmail: string | null;
  accessToken: string;
  scopes: string[];
  db?: GoatIntegrationDb;
  now?: Date;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const connectionLabel = input.teamName?.trim() || "Slack";

  const [integration] = await db
    .insert(goatIntegrations)
    .values({
      id: newGoatIntegrationId(),
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
      target: [
        goatIntegrations.userWorkosId,
        goatIntegrations.provider,
        goatIntegrations.externalId,
      ],
      // The personal-uniqueness index is partial; the arbiter must match it.
      targetWhere: sql`${goatIntegrations.workspaceId} IS NULL`,
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
    .returning({ id: goatIntegrations.id });

  if (!integration) {
    throw new Error("Could not persist Goat Slack integration.");
  }

  const payload: GoatSlackOAuthCredentialPayload = {
    access_token: input.accessToken,
    authed_user_id: input.authedUserId,
    team_id: input.teamId,
    ...(input.teamName ? { team_name: input.teamName } : {}),
    ...(input.teamDomain ? { team_domain: input.teamDomain } : {}),
    ...(input.scopes.length > 0 ? { scope: input.scopes.join(",") } : {}),
  };

  try {
    await saveGoatIntegrationCredential({
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
    await markGoatIntegrationStatus({
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

export type GoatLinearOAuthCredentialPayload = {
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
export async function connectGoatLinearIngestIntegration(input: {
  userWorkosId: string;
  organizationId: string;
  organizationName: string | null;
  organizationUrlKey: string | null;
  viewerId: string | null;
  viewerName: string | null;
  viewerEmail: string | null;
  accessToken: string;
  scopes: string[];
  db?: GoatIntegrationDb;
  now?: Date;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const connectionLabel = input.organizationName?.trim() || "Linear";

  const [integration] = await db
    .insert(goatIntegrations)
    .values({
      id: newGoatIntegrationId(),
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
      target: [
        goatIntegrations.userWorkosId,
        goatIntegrations.provider,
        goatIntegrations.externalId,
      ],
      // The personal-uniqueness index is partial; the arbiter must match it.
      targetWhere: sql`${goatIntegrations.workspaceId} IS NULL`,
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
    .returning({ id: goatIntegrations.id });

  if (!integration) {
    throw new Error("Could not persist Goat Linear integration.");
  }

  const payload: GoatLinearOAuthCredentialPayload = {
    access_token: input.accessToken,
    organization_id: input.organizationId,
    ...(input.organizationName ? { organization_name: input.organizationName } : {}),
    ...(input.organizationUrlKey ? { organization_url_key: input.organizationUrlKey } : {}),
    ...(input.viewerId ? { viewer_id: input.viewerId } : {}),
    ...(input.viewerName ? { viewer_name: input.viewerName } : {}),
    ...(input.scopes.length > 0 ? { scope: input.scopes.join(",") } : {}),
  };

  try {
    await saveGoatIntegrationCredential({
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
    await markGoatIntegrationStatus({
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

export async function saveGoatIntegrationCredential(
  input: GoatIntegrationCredentialContext & {
    payload: Record<string, unknown>;
    expiresAt?: Date | null;
    db?: GoatIntegrationDb;
    now?: Date;
  },
) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const keyVersion = DEFAULT_ENCRYPTION_KEY_VERSION;
  const encryptedPayload = encryptJson(input.payload, {
    key: loadEncryptionKey(keyVersion),
    aad: goatCredentialAad({ ...input, keyVersion }),
  });

  const [credential] = await db
    .insert(goatIntegrationCredentials)
    .values({
      id: newGoatIntegrationCredentialId(),
      userWorkosId: input.userWorkosId,
      integrationId: input.integrationId,
      provider: input.provider,
      kind: input.kind,
      encryptedPayload,
      encryptionKeyVersion: keyVersion,
      expiresAt: input.expiresAt ?? null,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [goatIntegrationCredentials.integrationId, goatIntegrationCredentials.kind],
      set: {
        userWorkosId: input.userWorkosId,
        provider: input.provider,
        encryptedPayload,
        encryptionKeyVersion: keyVersion,
        expiresAt: input.expiresAt ?? null,
        lastRotatedAt: now,
        updatedAt: now,
      },
    })
    .returning({
      id: goatIntegrationCredentials.id,
      expiresAt: goatIntegrationCredentials.expiresAt,
      lastRotatedAt: goatIntegrationCredentials.lastRotatedAt,
      updatedAt: goatIntegrationCredentials.updatedAt,
      encryptionKeyVersion: goatIntegrationCredentials.encryptionKeyVersion,
    });

  if (!credential) {
    throw new Error("Could not persist Goat integration credential.");
  }

  return credential;
}

export async function refreshGoatIntegrationCredential(
  input: GoatIntegrationCredentialContext & {
    payload: Record<string, unknown>;
    expiresAt?: Date | null;
    db: GoatIntegrationRootDb;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();

  return input.db.transaction(async (tx) => {
    const credential = await saveGoatIntegrationCredential({ ...input, db: tx, now });
    await markGoatIntegrationStatus({
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

export async function loadGoatIntegrationCredential(
  input: GoatIntegrationCredentialContext & { db?: Pick<ReturnType<typeof getDb>, "select"> },
): Promise<LoadedGoatIntegrationCredential | null> {
  const db = input.db ?? getDb();
  const [credential] = await db
    .select({
      userWorkosId: goatIntegrationCredentials.userWorkosId,
      integrationId: goatIntegrationCredentials.integrationId,
      provider: goatIntegrationCredentials.provider,
      kind: goatIntegrationCredentials.kind,
      encryptedPayload: goatIntegrationCredentials.encryptedPayload,
      encryptionKeyVersion: goatIntegrationCredentials.encryptionKeyVersion,
      expiresAt: goatIntegrationCredentials.expiresAt,
      lastRotatedAt: goatIntegrationCredentials.lastRotatedAt,
      updatedAt: goatIntegrationCredentials.updatedAt,
    })
    .from(goatIntegrationCredentials)
    .where(
      and(
        eq(goatIntegrationCredentials.userWorkosId, input.userWorkosId),
        eq(goatIntegrationCredentials.integrationId, input.integrationId),
        eq(goatIntegrationCredentials.provider, input.provider),
        eq(goatIntegrationCredentials.kind, input.kind),
      ),
    )
    .limit(1);

  if (!credential) return null;

  return {
    payload: decryptJson(credential.encryptedPayload, {
      key: loadEncryptionKey(credential.encryptionKeyVersion),
      aad: goatCredentialAad({
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

export async function markGoatIntegrationStatus(input: {
  userWorkosId: string;
  integrationId: string;
  provider: GoatIntegrationProvider;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected";
  statusReason?: string | null;
  db?: Pick<GoatIntegrationDb, "update">;
  now?: Date;
}) {
  await (input.db ?? getDb())
    .update(goatIntegrations)
    .set({
      status: input.status,
      statusReason: input.statusReason ? input.statusReason.slice(0, 240) : null,
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(goatIntegrations.userWorkosId, input.userWorkosId),
        eq(goatIntegrations.id, input.integrationId),
        eq(goatIntegrations.provider, input.provider),
      ),
    );
}

export function goatCredentialAad(
  input: GoatIntegrationCredentialContext & { keyVersion: number },
) {
  return buildAad({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: input.provider,
    kind: input.kind,
    keyVersion: input.keyVersion,
  });
}

function newGoatIntegrationId() {
  return `gint_${randomUUID().replace(/-/g, "")}`;
}

function newGoatIntegrationCredentialId() {
  return `gcred_${randomUUID().replace(/-/g, "")}`;
}
